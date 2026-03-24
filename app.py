import warnings
warnings.filterwarnings('ignore', category=UserWarning, module='openpyxl')

from flask import (Flask, render_template, request, jsonify, redirect,
                   url_for, session, flash, abort)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import pandas as pd
import sqlite3
import json
import os
import uuid
from datetime import datetime
from functools import wraps

app = Flask(__name__)
app.config['SECRET_KEY'] = 'dev-secret-key-change-in-production'
app.config['UPLOAD_FOLDER'] = os.path.join(os.path.dirname(__file__), 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024
DB_PATH = os.path.join(os.path.dirname(__file__), 'instance', 'dashboards.db')

os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

# ── DB Helpers ────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn

def init_db():
    with get_db() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dashboards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id)
            );
            CREATE TABLE IF NOT EXISTS datasets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                sheet_name TEXT DEFAULT 'Sheet1',
                columns_meta TEXT DEFAULT '[]',
                transforms TEXT DEFAULT '{}',
                row_count INTEGER DEFAULT 0,
                dashboard_id INTEGER NOT NULL,
                FOREIGN KEY(dashboard_id) REFERENCES dashboards(id)
            );
            -- Migration: add transforms column if not exists
            -- (SQLite ignores duplicate column errors via executescript)
            CREATE TABLE IF NOT EXISTS widgets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                title TEXT DEFAULT 'Untitled Widget',
                chart_type TEXT DEFAULT 'bar',
                dataset_id INTEGER,
                config TEXT DEFAULT '{}',
                layout TEXT DEFAULT '{}',
                dashboard_id INTEGER NOT NULL,
                FOREIGN KEY(dashboard_id) REFERENCES dashboards(id)
            );
        ''')
        # Safe migrations — add columns that may not exist in older DBs
        for migration in [
            "ALTER TABLE datasets ADD COLUMN transforms TEXT DEFAULT '{}'",
            "ALTER TABLE dashboards ADD COLUMN dashboard_filters TEXT DEFAULT '[]'",
        ]:
            try:
                db.execute(migration)
                db.commit()
            except Exception:
                pass

        row = db.execute('SELECT id FROM users LIMIT 1').fetchone()
        if not row:
            db.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)',
                       ('admin', generate_password_hash('admin')))
            db.commit()
            print("Default user created: admin / admin")

# ── Auth decorator ────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def current_user_id():
    return session.get('user_id')

def current_username():
    return session.get('username', '')

@app.context_processor
def inject_user():
    return dict(
        current_username=current_username(),
        is_authenticated='user_id' in session
    )

# ── Auth Routes ───────────────────────────────────────────────────────────────
@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('home'))
    return redirect(url_for('login'))

@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('home'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        with get_db() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if user and check_password_hash(user['password_hash'], password):
            session['user_id'] = user['id']
            session['username'] = user['username']
            return redirect(url_for('home'))
        flash('Invalid username or password', 'error')
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if 'user_id' in session:
        return redirect(url_for('home'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        if len(username) < 3:
            flash('Username must be at least 3 characters', 'error')
        elif len(password) < 4:
            flash('Password must be at least 4 characters', 'error')
        else:
            try:
                with get_db() as db:
                    db.execute('INSERT INTO users (username, password_hash) VALUES (?,?)',
                               (username, generate_password_hash(password)))
                    db.commit()
                    user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
                session['user_id'] = user['id']
                session['username'] = user['username']
                return redirect(url_for('home'))
            except sqlite3.IntegrityError:
                flash('Username already taken', 'error')
    return render_template('register.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# ── Home ───────────────────────────────────────────────────────────────────────
@app.route('/home')
@login_required
def home():
    uid = current_user_id()
    with get_db() as db:
        dashboards = db.execute(
            'SELECT * FROM dashboards WHERE user_id=? ORDER BY updated_at DESC', (uid,)
        ).fetchall()
        result = []
        for d in dashboards:
            ds_count = db.execute('SELECT COUNT(*) FROM datasets WHERE dashboard_id=?', (d['id'],)).fetchone()[0]
            wg_count = db.execute('SELECT COUNT(*) FROM widgets WHERE dashboard_id=?', (d['id'],)).fetchone()[0]
            entry = dict(d)
            entry['ds_count'] = ds_count
            entry['wg_count'] = wg_count
            # Parse date for display
            try:
                entry['updated_display'] = datetime.fromisoformat(d['updated_at']).strftime('%b %d, %Y')
            except Exception:
                entry['updated_display'] = d['updated_at'][:10]
            result.append(entry)
    return render_template('home.html', dashboards=result)

# ── Dashboard CRUD ─────────────────────────────────────────────────────────────
@app.route('/dashboard/new')
@login_required
def new_dashboard():
    return render_template('new_dashboard.html')

@app.route('/api/dashboard/create', methods=['POST'])
@login_required
def create_dashboard():
    name = request.form.get('name', '').strip()
    description = request.form.get('description', '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    now = datetime.utcnow().isoformat()
    dash_uid = str(uuid.uuid4())

    with get_db() as db:
        db.execute(
            'INSERT INTO dashboards (uid, name, description, created_at, updated_at, user_id) VALUES (?,?,?,?,?,?)',
            (dash_uid, name, description, now, now, current_user_id())
        )
        db.commit()
        dash_id = db.execute('SELECT id FROM dashboards WHERE uid=?', (dash_uid,)).fetchone()['id']

        files = request.files.getlist('files')
        for f in files:
            if f and f.filename and (f.filename.endswith('.xlsx') or f.filename.endswith('.xls') or f.filename.endswith('.csv')):
                try:
                    filename = secure_filename(f.filename)
                    unique_name = f"{uuid.uuid4()}_{filename}"
                    filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_name)
                    f.save(filepath)
                    cols_meta, row_count, sheet = parse_file_meta(filepath, f.filename)
                    db.execute(
                        'INSERT INTO datasets (name, filename, sheet_name, columns_meta, row_count, dashboard_id) VALUES (?,?,?,?,?,?)',
                        (f.filename, unique_name, sheet, json.dumps(cols_meta), row_count, dash_id)
                    )
                except Exception as e:
                    print(f"File error: {e}")
        db.commit()

    return jsonify({'redirect': url_for('dashboard_view', uid=dash_uid)})

def parse_file_meta(filepath, original_name):
    if original_name.endswith('.csv'):
        df = pd.read_csv(filepath)
        sheet = 'CSV'
    else:
        xl = pd.ExcelFile(filepath)
        sheet = xl.sheet_names[0]
        df = xl.parse(sheet)

    cols_meta = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        kind = 'numeric' if ('int' in dtype or 'float' in dtype) else ('date' if 'datetime' in dtype else 'text')
        cols_meta.append({'name': str(col), 'type': kind, 'dtype': dtype})
    return cols_meta, len(df), sheet

@app.route('/dashboard/<uid>')
@login_required
def dashboard_view(uid):
    with get_db() as db:
        dashboard = db.execute(
            'SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())
        ).fetchone()
        if not dashboard:
            abort(404)

        widgets_raw = db.execute('SELECT * FROM widgets WHERE dashboard_id=?', (dashboard['id'],)).fetchall()
        datasets_raw = db.execute('SELECT * FROM datasets WHERE dashboard_id=?', (dashboard['id'],)).fetchall()

    widgets_data = [
        {'id': w['id'], 'uid': w['uid'], 'title': w['title'],
         'chart_type': w['chart_type'], 'dataset_id': w['dataset_id'],
         'config': json.loads(w['config']), 'layout': json.loads(w['layout'])}
        for w in widgets_raw
    ]
    datasets_data = [
        {'id': d['id'], 'name': d['name'],
         'columns': json.loads(d['columns_meta']), 'row_count': d['row_count']}
        for d in datasets_raw
    ]

    # Load saved dashboard-level filters
    try:
        dash_filters = json.loads(dashboard['dashboard_filters'] or '[]')
    except Exception:
        dash_filters = []

    return render_template('dashboard.html',
        dashboard=dict(dashboard),
        widgets_json=json.dumps(widgets_data),
        datasets_json=json.dumps(datasets_data),
        dashboard_filters_json=json.dumps(dash_filters)
    )

@app.route('/api/dashboard/<uid>/filters', methods=['PUT'])
@login_required
def save_dashboard_filters(uid):
    with get_db() as db:
        d = db.execute('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())).fetchone()
        if not d:
            abort(404)
        data = request.get_json()
        filters = data.get('filters', [])
        now = datetime.utcnow().isoformat()
        db.execute('UPDATE dashboards SET dashboard_filters=?, updated_at=? WHERE uid=?',
                   (json.dumps(filters), now, uid))
        db.commit()
    return jsonify({'ok': True})

@app.route('/api/dashboard/<uid>/delete', methods=['POST'])
@login_required
def delete_dashboard(uid):
    with get_db() as db:
        d = db.execute('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())).fetchone()
        if not d:
            abort(404)
        db.execute('DELETE FROM widgets WHERE dashboard_id=?', (d['id'],))
        db.execute('DELETE FROM datasets WHERE dashboard_id=?', (d['id'],))
        db.execute('DELETE FROM dashboards WHERE id=?', (d['id'],))
        db.commit()
    return jsonify({'ok': True})

@app.route('/api/dashboard/<uid>/rename', methods=['POST'])
@login_required
def rename_dashboard(uid):
    data = request.get_json()
    now = datetime.utcnow().isoformat()
    with get_db() as db:
        db.execute('UPDATE dashboards SET name=?, updated_at=? WHERE uid=? AND user_id=?',
                   (data.get('name', '').strip(), now, uid, current_user_id()))
        db.commit()
    return jsonify({'ok': True})

# ── Dataset ────────────────────────────────────────────────────────────────────
@app.route('/api/dashboard/<uid>/upload', methods=['POST'])
@login_required
def upload_dataset(uid):
    with get_db() as db:
        d = db.execute('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())).fetchone()
        if not d:
            abort(404)
        dash_id = d['id']

    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file'}), 400

    filename = secure_filename(f.filename)
    unique_name = f"{uuid.uuid4()}_{filename}"
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_name)
    f.save(filepath)

    try:
        cols_meta, row_count, sheet = parse_file_meta(filepath, f.filename)
        now = datetime.utcnow().isoformat()
        with get_db() as db:
            db.execute(
                'INSERT INTO datasets (name, filename, sheet_name, columns_meta, row_count, dashboard_id) VALUES (?,?,?,?,?,?)',
                (f.filename, unique_name, sheet, json.dumps(cols_meta), row_count, dash_id)
            )
            db.execute('UPDATE dashboards SET updated_at=? WHERE id=?', (now, dash_id))
            db.commit()
            ds_id = db.execute('SELECT last_insert_rowid()').fetchone()[0]
        return jsonify({'id': ds_id, 'name': f.filename, 'columns': cols_meta, 'row_count': row_count})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def apply_transforms(df, transforms):
    """Apply column-level transforms to a dataframe.
    transforms = {
      'ColumnName': {
        'type': 'date'|'number'|'text'|'exclude'|'rename',
        'date_format': '...',   # for date parsing, empty = auto
        'date_trunc': 'day'|'week'|'month'|'quarter'|'year',  # optional truncation
        'rename_to': '...',     # for rename
        'text_case': 'upper'|'lower'|'title'|'strip',  # for text
        'fill_null': '...',     # fill null values
      }
    }
    """
    if not transforms:
        return df
    df = df.copy()
    renames = {}
    for col, t in transforms.items():
        if col not in df.columns:
            continue
        kind = t.get('type', '')
        try:
            if kind == 'exclude':
                df = df.drop(columns=[col])
                continue

            elif kind == 'date':
                fmt = t.get('date_format', '')
                if fmt:
                    # dayfirst=True as a fallback hint so DD/MM/YYYY formats
                    # are not misread as MM/DD/YYYY when the explicit format fails.
                    df[col] = pd.to_datetime(df[col], format=fmt, errors='coerce', dayfirst=True)
                else:
                    df[col] = pd.to_datetime(df[col], errors='coerce', dayfirst=True)
                # Time truncation — use pd.api.types instead of a hardcoded dtype
                # string so this works on both pandas 2 (datetime64[ns]) and
                # pandas 3 (datetime64[us]).
                trunc = t.get('date_trunc', '')
                if trunc and pd.api.types.is_datetime64_any_dtype(df[col]):
                    if trunc == 'week':
                        df[col] = df[col].dt.to_period('W').dt.start_time
                    elif trunc == 'month':
                        df[col] = df[col].dt.to_period('M').dt.start_time
                    elif trunc == 'quarter':
                        df[col] = df[col].dt.to_period('Q').dt.start_time
                    elif trunc == 'year':
                        df[col] = df[col].dt.to_period('Y').dt.start_time
                    elif trunc == 'day':
                        df[col] = df[col].dt.normalize()
                # Always format back to string for JSON serialization, regardless
                # of whether truncation was applied, so raw Timestamps never reach
                # json.dumps (which would produce null).
                if pd.api.types.is_datetime64_any_dtype(df[col]):
                    date_out_fmt = t.get('date_output_format', '%Y-%m-%d')
                    df[col] = df[col].dt.strftime(date_out_fmt).where(df[col].notna(), None)

            elif kind == 'number':
                df[col] = pd.to_numeric(df[col].astype(str).str.replace(r'[^\d.\-+eE]', '', regex=True), errors='coerce')

            elif kind == 'text':
                case = t.get('text_case', '')
                df[col] = df[col].astype(str)
                if case == 'upper':   df[col] = df[col].str.upper()
                elif case == 'lower': df[col] = df[col].str.lower()
                elif case == 'title': df[col] = df[col].str.title()
                elif case == 'strip': df[col] = df[col].str.strip()

            fill = t.get('fill_null', '')
            if fill != '' and fill is not None:
                df[col] = df[col].fillna(fill)

            if kind == 'rename':
                new_name = t.get('rename_to', '').strip()
                if new_name and new_name != col:
                    renames[col] = new_name

        except Exception as ex:
            print(f"[transform] Error on column '{col}' (type={kind}): {ex}")
            # skip broken transforms but log so issues are visible in server output

    if renames:
        df = df.rename(columns=renames)
    return df


@app.route('/api/dataset/<int:dataset_id>/data')
@login_required
def get_dataset_data(dataset_id):
    with get_db() as db:
        dataset = db.execute('SELECT * FROM datasets WHERE id=?', (dataset_id,)).fetchone()
        if not dataset:
            abort(404)
        d = db.execute('SELECT user_id FROM dashboards WHERE id=?', (dataset['dashboard_id'],)).fetchone()
        if not d or d['user_id'] != current_user_id():
            abort(403)

    filepath = os.path.join(app.config['UPLOAD_FOLDER'], dataset['filename'])
    try:
        if dataset['sheet_name'] == 'CSV':
            df = pd.read_csv(filepath)
        else:
            df = pd.read_excel(filepath, sheet_name=dataset['sheet_name'])

        # Apply stored column transforms
        try:
            raw_transforms = dataset['transforms'] if 'transforms' in dataset.keys() else '{}'
        except Exception:
            raw_transforms = '{}'
        transforms = json.loads(raw_transforms or '{}')
        # Also allow request-time override transforms (for live preview in panel)
        override_transforms = request.args.get('transforms')
        if override_transforms:
            transforms.update(json.loads(override_transforms))
        df = apply_transforms(df, transforms)

        filters_raw = request.args.get('filters')
        if filters_raw:
            filters = json.loads(filters_raw)
            for f in filters:
                col = f.get('column')
                op = f.get('operator')
                val = f.get('value')
                if col not in df.columns:
                    continue
                try:
                    # val may be a comma-separated list for multi-value operators
                    vals = [v.strip() for v in str(val).split(',') if v.strip()] if val else []
                    col_str = df[col].astype(str)
                    if op == 'equals':
                        if len(vals) > 1:  df = df[col_str.isin(vals)]
                        elif vals:         df = df[col_str == vals[0]]
                    elif op == 'not_equals':
                        if len(vals) > 1:  df = df[~col_str.isin(vals)]
                        elif vals:         df = df[col_str != vals[0]]
                    elif op == 'contains':
                        if len(vals) > 1:
                            mask = col_str.str.contains(vals[0], case=False, na=False)
                            for v in vals[1:]: mask |= col_str.str.contains(v, case=False, na=False)
                            df = df[mask]
                        elif vals:         df = df[col_str.str.contains(vals[0], case=False, na=False)]
                    elif op == 'not_contains':
                        if len(vals) > 1:
                            mask = col_str.str.contains(vals[0], case=False, na=False)
                            for v in vals[1:]: mask |= col_str.str.contains(v, case=False, na=False)
                            df = df[~mask]
                        elif vals:         df = df[~col_str.str.contains(vals[0], case=False, na=False)]
                    elif op in ('greater_than', 'less_than', 'greater_equal', 'less_equal'):
                        if vals:
                            num_col = pd.to_numeric(df[col], errors='coerce')
                            frac_valid = num_col.notna().sum() / max(len(num_col), 1)
                            if frac_valid >= 0.5:
                                # Mostly numeric — compare as numbers
                                threshold = float(vals[0])
                                if   op == 'greater_than':  df = df[num_col > threshold]
                                elif op == 'less_than':     df = df[num_col < threshold]
                                elif op == 'greater_equal': df = df[num_col >= threshold]
                                elif op == 'less_equal':    df = df[num_col <= threshold]
                            else:
                                # Treat as dates — parse both column and threshold
                                date_col = pd.to_datetime(df[col], errors='coerce', infer_datetime_format=True)
                                threshold_dt = pd.to_datetime(vals[0], errors='coerce', infer_datetime_format=True)
                                if date_col.notna().any() and not pd.isna(threshold_dt):
                                    if   op == 'greater_than':  df = df[date_col > threshold_dt]
                                    elif op == 'less_than':     df = df[date_col < threshold_dt]
                                    elif op == 'greater_equal': df = df[date_col >= threshold_dt]
                                    elif op == 'less_equal':    df = df[date_col <= threshold_dt]
                    elif op == 'in':            df = df[col_str.isin(vals)]
                    elif op == 'not_in':        df = df[~col_str.isin(vals)]
                    elif op == 'is_null':       df = df[df[col].isna()]
                    elif op == 'is_not_null':   df = df[df[col].notna()]
                except Exception:
                    pass

        limit = int(request.args.get('limit', 5000))
        df = df.head(limit)
        df = df.where(pd.notnull(df), None)
        return jsonify({'columns': list(df.columns), 'data': df.values.tolist(), 'total_rows': len(df)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── Dataset Transforms ────────────────────────────────────────────────────────

@app.route('/api/dataset/<int:dataset_id>/transforms', methods=['GET'])
@login_required
def get_transforms(dataset_id):
    with get_db() as db:
        ds = db.execute('SELECT * FROM datasets WHERE id=?', (dataset_id,)).fetchone()
        if not ds:
            abort(404)
        d = db.execute('SELECT user_id FROM dashboards WHERE id=?', (ds['dashboard_id'],)).fetchone()
        if not d or d['user_id'] != current_user_id():
            abort(403)
        try:
            transforms = json.loads(ds['transforms'] if 'transforms' in ds.keys() else '{}') if ds else {}
        except Exception:
            transforms = {}
        cols = json.loads(ds['columns_meta'])
    return jsonify({'transforms': transforms, 'columns': cols})

@app.route('/api/dataset/<int:dataset_id>/transforms', methods=['PUT'])
@login_required
def save_transforms(dataset_id):
    with get_db() as db:
        ds = db.execute('SELECT * FROM datasets WHERE id=?', (dataset_id,)).fetchone()
        if not ds:
            abort(404)
        d = db.execute('SELECT user_id, id FROM dashboards WHERE id=?', (ds['dashboard_id'],)).fetchone()
        if not d or d['user_id'] != current_user_id():
            abort(403)
        data = request.get_json()
        transforms = data.get('transforms', {})
        db.execute('UPDATE datasets SET transforms=? WHERE id=?', (json.dumps(transforms), dataset_id))
        db.execute('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
        db.commit()
    # Invalidate cache hint
    return jsonify({'ok': True})

# ── Widget CRUD ────────────────────────────────────────────────────────────────
@app.route('/api/dashboard/<uid>/widget', methods=['POST'])
@login_required
def create_widget(uid):
    with get_db() as db:
        d = db.execute('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())).fetchone()
        if not d:
            abort(404)
        data = request.get_json()
        widget_uid = str(uuid.uuid4())
        db.execute(
            'INSERT INTO widgets (uid, title, chart_type, dataset_id, config, layout, dashboard_id) VALUES (?,?,?,?,?,?,?)',
            (widget_uid, data.get('title', 'New Widget'), data.get('chart_type', 'bar'),
             data.get('dataset_id'), json.dumps(data.get('config', {})),
             json.dumps(data.get('layout', {'x': 0, 'y': 0, 'w': 6, 'h': 4})), d['id'])
        )
        db.execute('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
        db.commit()
        w_id = db.execute('SELECT id FROM widgets WHERE uid=?', (widget_uid,)).fetchone()['id']
    return jsonify({'id': w_id, 'uid': widget_uid})

@app.route('/api/widget/<uid>', methods=['PUT'])
@login_required
def update_widget(uid):
    with get_db() as db:
        w = db.execute('SELECT * FROM widgets WHERE uid=?', (uid,)).fetchone()
        if not w:
            abort(404)
        d = db.execute('SELECT user_id, id FROM dashboards WHERE id=?', (w['dashboard_id'],)).fetchone()
        if not d or d['user_id'] != current_user_id():
            abort(403)
        data = request.get_json()
        fields = []
        vals = []
        for field in ['title', 'chart_type', 'dataset_id']:
            if field in data:
                fields.append(f'{field}=?')
                vals.append(data[field])
        if 'config' in data:
            fields.append('config=?')
            vals.append(json.dumps(data['config']))
        if 'layout' in data:
            fields.append('layout=?')
            vals.append(json.dumps(data['layout']))
        if fields:
            vals.append(uid)
            db.execute(f'UPDATE widgets SET {",".join(fields)} WHERE uid=?', vals)
        db.execute('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
        db.commit()
    return jsonify({'ok': True})

@app.route('/api/widget/<uid>', methods=['DELETE'])
@login_required
def delete_widget(uid):
    with get_db() as db:
        w = db.execute('SELECT * FROM widgets WHERE uid=?', (uid,)).fetchone()
        if not w:
            abort(404)
        d = db.execute('SELECT user_id FROM dashboards WHERE id=?', (w['dashboard_id'],)).fetchone()
        if not d or d['user_id'] != current_user_id():
            abort(403)
        db.execute('DELETE FROM widgets WHERE uid=?', (uid,))
        db.commit()
    return jsonify({'ok': True})

@app.route('/api/dashboard/<uid>/widgets/layout', methods=['PUT'])
@login_required
def update_layouts(uid):
    with get_db() as db:
        d = db.execute('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())).fetchone()
        if not d:
            abort(404)
        data = request.get_json()
        for item in data:
            db.execute('UPDATE widgets SET layout=? WHERE uid=? AND dashboard_id=?',
                       (json.dumps(item['layout']), item['uid'], d['id']))
        db.commit()
    return jsonify({'ok': True})

# ── Run ────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    app.run(debug=True, port=5050)