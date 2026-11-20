#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > card.css <<'CSS'
.card {
  width: 320px;
  padding: 16px;
  border-radius: 8px;
  background: #fff;
}
.card h3 {
  font-size: 18px;
  margin: 0 0 8px;
}
CSS
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
