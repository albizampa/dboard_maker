import warnings
warnings.filterwarnings('ignore', category=UserWarning, module='openpyxl')

from flask import (Flask, render_template, request, jsonify, redirect,
                   url_for, session, flash, abort)
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
import pandas as pd
import json
import os
import uuid
import io
from datetime import datetime
from functools import wraps

# ── Database backend: Supabase Postgres (prod) or SQLite (dev fallback) ───────
USE_SUPABASE = bool(os.environ.get('DATABASE_URL') or os.environ.get('SUPABASE_DB_URL'))

if USE_SUPABASE:
    import psycopg2
    import psycopg2.extras
    from supabase import create_client, Client as SupabaseClient

    SUPABASE_URL = os.environ['SUPABASE_URL']
    SUPABASE_KEY = os.environ['SUPABASE_SERVICE_KEY']   # service role key for Storage
    SUPABASE_BUCKET = os.environ.get('SUPABASE_BUCKET', 'datalens-uploads')
    DATABASE_URL = os.environ.get('DATABASE_URL') or os.environ.get('SUPABASE_DB_URL')

    _supabase: SupabaseClient = create_client(SUPABASE_URL, SUPABASE_KEY)

else:
    import sqlite3
    DB_PATH = os.path.join(os.path.dirname(__file__), 'instance', 'dashboards.db')
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024


# ══════════════════════════════════════════════════════════════════════════════
# DATABASE ABSTRACTION
# ══════════════════════════════════════════════════════════════════════════════

class DB:
    """Thin wrapper that speaks either Postgres (Supabase) or SQLite."""

    # ── Connection ─────────────────────────────────────────────────────────
    @staticmethod
    def _pg():
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
        conn.autocommit = False
        return conn

    @staticmethod
    def _sqlite():
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        return conn

    # ── Init schema ────────────────────────────────────────────────────────
    @staticmethod
    def init():
        if USE_SUPABASE:
            conn = DB._pg()
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS dashboards (
                    id SERIAL PRIMARY KEY,
                    uid TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    dashboard_filters TEXT DEFAULT '[]'
                );
                CREATE TABLE IF NOT EXISTS datasets (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    sheet_name TEXT DEFAULT 'Sheet1',
                    columns_meta TEXT DEFAULT '[]',
                    transforms TEXT DEFAULT '{}',
                    row_count INTEGER DEFAULT 0,
                    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id)
                );
                CREATE TABLE IF NOT EXISTS widgets (
                    id SERIAL PRIMARY KEY,
                    uid TEXT UNIQUE NOT NULL,
                    title TEXT DEFAULT 'Untitled Widget',
                    chart_type TEXT DEFAULT 'bar',
                    dataset_id INTEGER,
                    config TEXT DEFAULT '{}',
                    layout TEXT DEFAULT '{}',
                    dashboard_id INTEGER NOT NULL REFERENCES dashboards(id)
                );
            """)
            # Seed default user
            cur.execute("SELECT id FROM users LIMIT 1")
            if not cur.fetchone():
                cur.execute(
                    "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
                    ('admin', generate_password_hash('admin'))
                )
                print("Default user created: admin / admin")
            conn.commit()
            cur.close()
            conn.close()
        else:
            # SQLite path (unchanged from original)
            with DB._sqlite() as conn:
                conn.executescript('''
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
                for migration in [
                    "ALTER TABLE datasets ADD COLUMN transforms TEXT DEFAULT '{}'",
                    "ALTER TABLE dashboards ADD COLUMN dashboard_filters TEXT DEFAULT '[]'",
                ]:
                    try:
                        conn.execute(migration)
                        conn.commit()
                    except Exception:
                        pass
                row = conn.execute('SELECT id FROM users LIMIT 1').fetchone()
                if not row:
                    conn.execute(
                        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
                        ('admin', generate_password_hash('admin'))
                    )
                    conn.commit()
                    print("Default user created: admin / admin")

    # ── Generic query helpers ──────────────────────────────────────────────
    @staticmethod
    def fetchone(sql, params=()):
        if USE_SUPABASE:
            conn = DB._pg()
            cur = conn.cursor()
            cur.execute(sql, params)
            row = cur.fetchone()
            cur.close(); conn.close()
            return dict(row) if row else None
        else:
            with DB._sqlite() as conn:
                row = conn.execute(sql, params).fetchone()
                return dict(row) if row else None

    @staticmethod
    def fetchall(sql, params=()):
        if USE_SUPABASE:
            conn = DB._pg()
            cur = conn.cursor()
            cur.execute(sql, params)
            rows = cur.fetchall()
            cur.close(); conn.close()
            return [dict(r) for r in rows]
        else:
            with DB._sqlite() as conn:
                rows = conn.execute(sql, params).fetchall()
                return [dict(r) for r in rows]

    @staticmethod
    def execute(sql, params=()):
        """Execute a single DML statement and return lastrowid/id."""
        if USE_SUPABASE:
            conn = DB._pg()
            cur = conn.cursor()
            # Postgres: use RETURNING id for INSERT
            if sql.strip().upper().startswith('INSERT'):
                if 'RETURNING' not in sql.upper():
                    sql = sql.rstrip(';') + ' RETURNING id'
                cur.execute(sql, params)
                row = cur.fetchone()
                last_id = row['id'] if row else None
            else:
                cur.execute(sql, params)
                last_id = None
            conn.commit(); cur.close(); conn.close()
            return last_id
        else:
            with DB._sqlite() as conn:
                cur = conn.execute(sql, params)
                conn.commit()
                return cur.lastrowid

    @staticmethod
    def _pg_sql(sql):
        """Convert ? placeholders to %s for Postgres."""
        return sql.replace('?', '%s')

    @staticmethod
    def q(sql, params=()):
        """Auto-convert ? → %s when using Postgres."""
        if USE_SUPABASE:
            return DB.fetchone(DB._pg_sql(sql), params)
        return DB.fetchone(sql, params)

    @staticmethod
    def qa(sql, params=()):
        if USE_SUPABASE:
            return DB.fetchall(DB._pg_sql(sql), params)
        return DB.fetchall(sql, params)

    @staticmethod
    def ex(sql, params=()):
        if USE_SUPABASE:
            return DB.execute(DB._pg_sql(sql), params)
        return DB.execute(sql, params)

def initialize_database():
    """Initialize schema/users for both local run and WSGI servers."""
    DB.init()


# ══════════════════════════════════════════════════════════════════════════════
# FILE STORAGE ABSTRACTION
# ══════════════════════════════════════════════════════════════════════════════

class FileStore:
    """Upload to / download from Supabase Storage or local disk."""

    @staticmethod
    def save(file_obj, unique_name: str) -> str:
        """Save file and return the storage key (unique_name)."""
        if USE_SUPABASE:
            data = file_obj.read()
            _supabase.storage.from_(SUPABASE_BUCKET).upload(
                path=unique_name,
                file=data,
                file_options={"content-type": "application/octet-stream", "upsert": "true"}
            )
        else:
            filepath = os.path.join(UPLOAD_FOLDER, unique_name)
            file_obj.save(filepath)
        return unique_name

    @staticmethod
    def load_dataframe(unique_name: str, sheet_name: str) -> pd.DataFrame:
        """Return a DataFrame for a stored file."""
        if USE_SUPABASE:
            data = _supabase.storage.from_(SUPABASE_BUCKET).download(unique_name)
            buf = io.BytesIO(data)
            if sheet_name == 'CSV':
                return pd.read_csv(buf)
            else:
                return pd.read_excel(buf, sheet_name=sheet_name)
        else:
            filepath = os.path.join(UPLOAD_FOLDER, unique_name)
            if sheet_name == 'CSV':
                return pd.read_csv(filepath)
            else:
                return pd.read_excel(filepath, sheet_name=sheet_name)

    @staticmethod
    def delete(unique_name: str):
        """Delete a stored file."""
        if USE_SUPABASE:
            try:
                _supabase.storage.from_(SUPABASE_BUCKET).remove([unique_name])
            except Exception:
                pass
        else:
            try:
                os.remove(os.path.join(UPLOAD_FOLDER, unique_name))
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════════════════
# AUTH HELPERS
# ══════════════════════════════════════════════════════════════════════════════

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


# ══════════════════════════════════════════════════════════════════════════════
# AUTH ROUTES
# ══════════════════════════════════════════════════════════════════════════════

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
        user = DB.q('SELECT * FROM users WHERE username=?', (username,))
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
            existing = DB.q('SELECT id FROM users WHERE username=?', (username,))
            if existing:
                flash('Username already taken', 'error')
            else:
                uid = DB.ex(
                    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
                    (username, generate_password_hash(password))
                )
                user = DB.q('SELECT * FROM users WHERE username=?', (username,))
                session['user_id'] = user['id']
                session['username'] = user['username']
                return redirect(url_for('home'))
    return render_template('register.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ══════════════════════════════════════════════════════════════════════════════
# HOME
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/home')
@login_required
def home():
    uid = current_user_id()
    dashboards = DB.qa(
        'SELECT * FROM dashboards WHERE user_id=? ORDER BY updated_at DESC', (uid,)
    )
    result = []
    for d in dashboards:
        ds_count = DB.q('SELECT COUNT(*) as c FROM datasets WHERE dashboard_id=?', (d['id'],))['c']
        wg_count = DB.q('SELECT COUNT(*) as c FROM widgets WHERE dashboard_id=?', (d['id'],))['c']
        entry = dict(d)
        entry['datasets'] = [None] * ds_count   # template uses |length
        entry['widgets']  = [None] * wg_count
        try:
            entry['updated_display'] = datetime.fromisoformat(d['updated_at']).strftime('%b %d, %Y')
        except Exception:
            entry['updated_display'] = str(d['updated_at'])[:10]
        result.append(entry)
    return render_template('home.html', dashboards=result)


# ══════════════════════════════════════════════════════════════════════════════
# DASHBOARD CRUD
# ══════════════════════════════════════════════════════════════════════════════

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

    dash_id = DB.ex(
        'INSERT INTO dashboards (uid, name, description, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        (dash_uid, name, description, now, now, current_user_id())
    )

    files = request.files.getlist('files')
    for f in files:
        if f and f.filename and f.filename.lower().endswith(('.xlsx', '.xls', '.csv')):
            try:
                filename = secure_filename(f.filename)
                unique_name = f"{uuid.uuid4()}_{filename}"
                FileStore.save(f, unique_name)
                cols_meta, row_count, sheet = parse_file_meta(unique_name, f.filename)
                DB.ex(
                    'INSERT INTO datasets (name, filename, sheet_name, columns_meta, row_count, dashboard_id) VALUES (?, ?, ?, ?, ?, ?)',
                    (f.filename, unique_name, sheet, json.dumps(cols_meta), row_count, dash_id)
                )
            except Exception as e:
                print(f"File error: {e}")

    return jsonify({'redirect': url_for('dashboard_view', uid=dash_uid)})


def parse_file_meta(unique_name, original_name):
    df = FileStore.load_dataframe(unique_name, 'CSV' if original_name.lower().endswith('.csv') else None)
    if not original_name.lower().endswith('.csv'):
        # Re-load with sheet detection
        if USE_SUPABASE:
            data = _supabase.storage.from_(SUPABASE_BUCKET).download(unique_name)
            buf = io.BytesIO(data)
            xl = pd.ExcelFile(buf)
        else:
            xl = pd.ExcelFile(os.path.join(UPLOAD_FOLDER, unique_name))
        sheet = xl.sheet_names[0]
        df = xl.parse(sheet)
    else:
        sheet = 'CSV'

    cols_meta = []
    for col in df.columns:
        dtype = str(df[col].dtype)
        kind = 'numeric' if ('int' in dtype or 'float' in dtype) else ('date' if 'datetime' in dtype else 'text')
        cols_meta.append({'name': str(col), 'type': kind, 'dtype': dtype})
    return cols_meta, len(df), sheet


@app.route('/dashboard/<uid>')
@login_required
def dashboard_view(uid):
    dashboard = DB.q(
        'SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id())
    )
    if not dashboard:
        abort(404)

    widgets_raw  = DB.qa('SELECT * FROM widgets WHERE dashboard_id=?',  (dashboard['id'],))
    datasets_raw = DB.qa('SELECT * FROM datasets WHERE dashboard_id=?', (dashboard['id'],))

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

    try:
        dash_filters = json.loads(dashboard.get('dashboard_filters') or '[]')
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
    d = DB.q('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id()))
    if not d:
        abort(404)
    data = request.get_json()
    filters = data.get('filters', [])
    now = datetime.utcnow().isoformat()
    DB.ex('UPDATE dashboards SET dashboard_filters=?, updated_at=? WHERE uid=?',
          (json.dumps(filters), now, uid))
    return jsonify({'ok': True})


@app.route('/api/dashboard/<uid>/delete', methods=['POST'])
@login_required
def delete_dashboard(uid):
    d = DB.q('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id()))
    if not d:
        abort(404)
    # Delete stored files
    datasets = DB.qa('SELECT filename FROM datasets WHERE dashboard_id=?', (d['id'],))
    for ds in datasets:
        FileStore.delete(ds['filename'])
    DB.ex('DELETE FROM widgets WHERE dashboard_id=?',  (d['id'],))
    DB.ex('DELETE FROM datasets WHERE dashboard_id=?', (d['id'],))
    DB.ex('DELETE FROM dashboards WHERE id=?',         (d['id'],))
    return jsonify({'ok': True})


@app.route('/api/dashboard/<uid>/rename', methods=['POST'])
@login_required
def rename_dashboard(uid):
    data = request.get_json()
    now = datetime.utcnow().isoformat()
    DB.ex('UPDATE dashboards SET name=?, updated_at=? WHERE uid=? AND user_id=?',
          (data.get('name', '').strip(), now, uid, current_user_id()))
    return jsonify({'ok': True})


# ══════════════════════════════════════════════════════════════════════════════
# DATASET
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/dashboard/<uid>/upload', methods=['POST'])
@login_required
def upload_dataset(uid):
    d = DB.q('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id()))
    if not d:
        abort(404)

    f = request.files.get('file')
    if not f:
        return jsonify({'error': 'No file'}), 400

    filename = secure_filename(f.filename)
    unique_name = f"{uuid.uuid4()}_{filename}"

    try:
        FileStore.save(f, unique_name)
        cols_meta, row_count, sheet = parse_file_meta(unique_name, f.filename)
        now = datetime.utcnow().isoformat()
        ds_id = DB.ex(
            'INSERT INTO datasets (name, filename, sheet_name, columns_meta, row_count, dashboard_id) VALUES (?, ?, ?, ?, ?, ?)',
            (f.filename, unique_name, sheet, json.dumps(cols_meta), row_count, d['id'])
        )
        DB.ex('UPDATE dashboards SET updated_at=? WHERE id=?', (now, d['id']))
        return jsonify({'id': ds_id, 'name': f.filename, 'columns': cols_meta, 'row_count': row_count})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def apply_transforms(df, transforms):
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
                    df[col] = pd.to_datetime(df[col], format=fmt, errors='coerce', dayfirst=True)
                else:
                    df[col] = pd.to_datetime(df[col], errors='coerce', dayfirst=True)
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
                if pd.api.types.is_datetime64_any_dtype(df[col]):
                    date_out_fmt = t.get('date_output_format', '%Y-%m-%d')
                    df[col] = df[col].dt.strftime(date_out_fmt).where(df[col].notna(), None)
            elif kind == 'number':
                df[col] = pd.to_numeric(
                    df[col].astype(str).str.replace(r'[^\d.\-+eE]', '', regex=True),
                    errors='coerce'
                )
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

    if renames:
        df = df.rename(columns=renames)
    return df


@app.route('/api/dataset/<int:dataset_id>/data')
@login_required
def get_dataset_data(dataset_id):
    dataset = DB.q('SELECT * FROM datasets WHERE id=?', (dataset_id,))
    if not dataset:
        abort(404)
    d = DB.q('SELECT user_id FROM dashboards WHERE id=?', (dataset['dashboard_id'],))
    if not d or d['user_id'] != current_user_id():
        abort(403)

    try:
        df = FileStore.load_dataframe(dataset['filename'], dataset['sheet_name'])

        transforms = json.loads(dataset.get('transforms') or '{}')
        override_transforms = request.args.get('transforms')
        if override_transforms:
            transforms.update(json.loads(override_transforms))
        df = apply_transforms(df, transforms)

        filters_raw = request.args.get('filters')
        if filters_raw:
            filters = json.loads(filters_raw)
            for f in filters:
                col = f.get('column')
                op  = f.get('operator')
                val = f.get('value')
                if col not in df.columns:
                    continue
                try:
                    vals = [v.strip() for v in str(val).split(',') if v.strip()] if val else []
                    col_str = df[col].astype(str)
                    if op == 'equals':
                        df = df[col_str.isin(vals)] if len(vals) > 1 else df[col_str == vals[0]] if vals else df
                    elif op == 'not_equals':
                        df = df[~col_str.isin(vals)] if len(vals) > 1 else df[col_str != vals[0]] if vals else df
                    elif op == 'contains':
                        if vals:
                            mask = col_str.str.contains(vals[0], case=False, na=False)
                            for v in vals[1:]: mask |= col_str.str.contains(v, case=False, na=False)
                            df = df[mask]
                    elif op == 'not_contains':
                        if vals:
                            mask = col_str.str.contains(vals[0], case=False, na=False)
                            for v in vals[1:]: mask |= col_str.str.contains(v, case=False, na=False)
                            df = df[~mask]
                    elif op in ('greater_than', 'less_than', 'greater_equal', 'less_equal'):
                        if vals:
                            num_col = pd.to_numeric(df[col], errors='coerce')
                            frac_valid = num_col.notna().sum() / max(len(num_col), 1)
                            if frac_valid >= 0.5:
                                threshold = float(vals[0])
                                if   op == 'greater_than':  df = df[num_col > threshold]
                                elif op == 'less_than':     df = df[num_col < threshold]
                                elif op == 'greater_equal': df = df[num_col >= threshold]
                                elif op == 'less_equal':    df = df[num_col <= threshold]
                            else:
                                date_col = pd.to_datetime(df[col], errors='coerce', infer_datetime_format=True)
                                threshold_dt = pd.to_datetime(vals[0], errors='coerce', infer_datetime_format=True)
                                if date_col.notna().any() and not pd.isna(threshold_dt):
                                    if   op == 'greater_than':  df = df[date_col > threshold_dt]
                                    elif op == 'less_than':     df = df[date_col < threshold_dt]
                                    elif op == 'greater_equal': df = df[date_col >= threshold_dt]
                                    elif op == 'less_equal':    df = df[date_col <= threshold_dt]
                    elif op == 'in':          df = df[col_str.isin(vals)]
                    elif op == 'not_in':      df = df[~col_str.isin(vals)]
                    elif op == 'is_null':     df = df[df[col].isna()]
                    elif op == 'is_not_null': df = df[df[col].notna()]
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
    ds = DB.q('SELECT * FROM datasets WHERE id=?', (dataset_id,))
    if not ds:
        abort(404)
    d = DB.q('SELECT user_id FROM dashboards WHERE id=?', (ds['dashboard_id'],))
    if not d or d['user_id'] != current_user_id():
        abort(403)
    try:
        transforms = json.loads(ds.get('transforms') or '{}')
    except Exception:
        transforms = {}
    cols = json.loads(ds['columns_meta'])
    return jsonify({'transforms': transforms, 'columns': cols})


@app.route('/api/dataset/<int:dataset_id>/transforms', methods=['PUT'])
@login_required
def save_transforms(dataset_id):
    ds = DB.q('SELECT * FROM datasets WHERE id=?', (dataset_id,))
    if not ds:
        abort(404)
    d = DB.q('SELECT user_id, id FROM dashboards WHERE id=?', (ds['dashboard_id'],))
    if not d or d['user_id'] != current_user_id():
        abort(403)
    data = request.get_json()
    transforms = data.get('transforms', {})
    DB.ex('UPDATE datasets SET transforms=? WHERE id=?', (json.dumps(transforms), dataset_id))
    DB.ex('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
    return jsonify({'ok': True})


# ══════════════════════════════════════════════════════════════════════════════
# WIDGET CRUD
# ══════════════════════════════════════════════════════════════════════════════

@app.route('/api/dashboard/<uid>/widget', methods=['POST'])
@login_required
def create_widget(uid):
    d = DB.q('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id()))
    if not d:
        abort(404)
    data = request.get_json()
    widget_uid = str(uuid.uuid4())
    w_id = DB.ex(
        'INSERT INTO widgets (uid, title, chart_type, dataset_id, config, layout, dashboard_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (widget_uid, data.get('title', 'New Widget'), data.get('chart_type', 'bar'),
         data.get('dataset_id'), json.dumps(data.get('config', {})),
         json.dumps(data.get('layout', {'x': 0, 'y': 0, 'w': 6, 'h': 4})), d['id'])
    )
    DB.ex('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
    return jsonify({'id': w_id, 'uid': widget_uid})


@app.route('/api/widget/<uid>', methods=['PUT'])
@login_required
def update_widget(uid):
    w = DB.q('SELECT * FROM widgets WHERE uid=?', (uid,))
    if not w:
        abort(404)
    d = DB.q('SELECT user_id, id FROM dashboards WHERE id=?', (w['dashboard_id'],))
    if not d or d['user_id'] != current_user_id():
        abort(403)
    data = request.get_json()
    fields, vals = [], []
    for field in ['title', 'chart_type', 'dataset_id']:
        if field in data:
            fields.append(f'{field}=?')
            vals.append(data[field])
    if 'config' in data:
        fields.append('config=?'); vals.append(json.dumps(data['config']))
    if 'layout' in data:
        fields.append('layout=?'); vals.append(json.dumps(data['layout']))
    if fields:
        vals.append(uid)
        DB.ex(f'UPDATE widgets SET {",".join(fields)} WHERE uid=?', vals)
    DB.ex('UPDATE dashboards SET updated_at=? WHERE id=?', (datetime.utcnow().isoformat(), d['id']))
    return jsonify({'ok': True})


@app.route('/api/widget/<uid>', methods=['DELETE'])
@login_required
def delete_widget(uid):
    w = DB.q('SELECT * FROM widgets WHERE uid=?', (uid,))
    if not w:
        abort(404)
    d = DB.q('SELECT user_id FROM dashboards WHERE id=?', (w['dashboard_id'],))
    if not d or d['user_id'] != current_user_id():
        abort(403)
    DB.ex('DELETE FROM widgets WHERE uid=?', (uid,))
    return jsonify({'ok': True})


@app.route('/api/dashboard/<uid>/widgets/layout', methods=['PUT'])
@login_required
def update_layouts(uid):
    d = DB.q('SELECT * FROM dashboards WHERE uid=? AND user_id=?', (uid, current_user_id()))
    if not d:
        abort(404)
    data = request.get_json()
    for item in data:
        DB.ex('UPDATE widgets SET layout=? WHERE uid=? AND dashboard_id=?',
              (json.dumps(item['layout']), item['uid'], d['id']))
    return jsonify({'ok': True})


# ══════════════════════════════════════════════════════════════════════════════
# RUN
# ══════════════════════════════════════════════════════════════════════════════

initialize_database()

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5050))
    debug = not USE_SUPABASE
    app.run(debug=debug, host='0.0.0.0', port=port)
