#!/usr/bin/env bash

echo "Starting neovim install..."

latest_version="${1:-latest}"

if [ "$latest_version" = "latest" ]; then
  latest_version="$(curl -s https://api.github.com/repos/neovim/neovim/releases/latest | jq -r .tag_name)"
fi

echo "Installing version: $latest_version"

git clone --depth 1 --branch $latest_version --single-branch https://github.com/neovim/neovim
cd neovim
git checkout $latest_version
make CMAKE_BUILD_TYPE=Release
sudo make install
cd ..
rm -rf neovim
