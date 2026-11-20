#!/bin/sh
cd "$1" && sed -i.bak "s|<p>Settings</p>|<a href=\"/\">Back</a><p>Settings</p>|" pages.js && rm pages.js.bak
