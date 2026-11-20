#!/bin/sh
cd "$1" && sed -i.bak 's/No items found/Add your first task to get started/' view.js && rm view.js.bak
