#!/bin/sh
set -e
d="$1"; mkdir -p "$d"; cd "$d"
git init -q -b main
cat > index.html <<'HTML'
<div class="dashboard">
  <div class="panel"><h2>Welcome back</h2><p>Here is a summary of your account activity for the week.</p></div>
  <div class="panel"><h2>Stats</h2><table><tr><td>Visits</td><td>10</td></tr><tr><td>Sales</td><td>2</td></tr></table></div>
  <div class="panel"><h2>Tips</h2><p>Use the filters to narrow results.</p><p>Click a row to expand it.</p></div>
  <div class="panel"><h2>Help</h2><p>Contact support if anything looks wrong.</p></div>
</div>
HTML
git add -A
git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m initial
