#!/bin/sh
cd "$1" && sed -i.bak 's/width: 320px/width: 288px/' card.css && rm card.css.bak
