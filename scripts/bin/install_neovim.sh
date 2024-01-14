#!/usr/bin/env bash

echo "Starting neovim install..."
wget https://github.com/neovim/neovim/releases/download/stable/nvim-macos.tar.gz
tar xzvf nvim-macos.tar.gz
cd nvim-macos
make CMAKE_BUILD_TYPE=Release
sudo make install
cd ..
rm -rf nvim-macos nvim-macos.tar.gz
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'
