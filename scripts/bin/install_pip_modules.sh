#!/usr/bin/env bash

pip_packages=(
  subliminal
  omnitagger
  yt-dlp
  vim-vint
  pretzelai
)

pip3 install "${pip_packages[@]}" --user

# After installing pretzal-ai for notebooks, set the app dir.
jupyter lab --generate-config
$HOME/.jupyter/jupyter_lab_config.py
sed -i '' 's/# c.LabApp.app_dir = None/c.LabApp.app_dir = "\/opt\/homebrew\/share\/jupyter\/lab"/g' $HOME/.jupyter/jupyter_lab_config.py

echo "Installed pip3 modules."
exit 0
