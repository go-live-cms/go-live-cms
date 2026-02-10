#!/bin/sh
# Start theme CSS watcher in background
npm run themes:watch &
THEME_PID=$!

# Start Astro dev server in foreground
npm run dev:docker

# Cleanup on exit
kill $THEME_PID 2>/dev/null
