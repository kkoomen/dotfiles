#!/usr/bin/env bash

npm_packages=(
  # Package managers
  bun

  # For security check npm packages
  nsp
)

sudo npm install -g "${npm_packages[@]}"
echo "Installed NPM modules."
exit 0
