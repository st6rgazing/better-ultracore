#!/bin/sh
cd "$1" && cat > src/Toolbar.jsx <<'JSX'
import React from 'react';
import { Save, Trash2, Share2 } from 'lucide-react';

export default function Toolbar({ onSave, onDelete, onShare }) {
  return (
    <div className="toolbar">
      <button onClick={onSave}><Save /> Save</button>
      <button onClick={onDelete}><Trash2 /> Delete</button>
      <button onClick={onShare}><Share2 /> Share</button>
    </div>
  );
}
JSX
