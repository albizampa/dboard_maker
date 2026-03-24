#!/bin/bash
# Run this after cloning your repo to complete the deployment setup
# Usage: bash setup_from_repo.sh /path/to/your/original/repo

REPO=${1:-.}
echo "Copying unchanged frontend files from $REPO..."

cp "$REPO/templates/dashboard.html" templates/dashboard.html && echo "✅ dashboard.html"
cp "$REPO/static/js/dashboard.js" static/js/dashboard.js && echo "✅ dashboard.js"

echo ""
echo "Done. All files are ready."
echo "Next: push to GitHub and deploy to Render."
