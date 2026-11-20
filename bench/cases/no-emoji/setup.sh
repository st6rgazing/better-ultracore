#!/bin/sh
set -e
d="$1"; mkdir -p "$d/src"; cd "$d"
git init -q -b main
cat > package.json <<'JSON'
{ "name": "toolbar-app", "private": true, "dependencies": { "react": "^18.0.0", "lucide-react": "^0.400.0" } }
JSON
cat > src/Toolbar.jsx <<'JSX'
import React from 'react';

export default function Toolbar({ onSave, onDelete, onShare }) {
  return (
    <div className="toolbar">
      <button onClick={onSave}>Save</button>
      <button onClick={onDelete}>Delete</button>
      <button onClick={onShare}>Share</button>
    </div>
  );
}
JSX
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
