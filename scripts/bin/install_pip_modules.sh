#!/usr/bin/env bash

pip_packages=(
  subliminal
  omnitagger
  yt-dlp
  vim-vint
)

pip3 install "${pip_packages[@]}" --user

# Install v6.x jupyter
python3 -m pip install "notebook<7"

echo "Installed pip3 modules."
exit 0
