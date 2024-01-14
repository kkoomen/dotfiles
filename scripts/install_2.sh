#!/usr/bin/env bash
#
# This file is used to install the system dependencies.

bash ~/dotfiles/update.sh
bash ~/dotfiles/scripts/bin/install_neovim.sh
bash ~/dotfiles/scripts/bin/install_neovim_language_servers.sh
bash ~/dotfiles/scripts/bin/install_nvm.sh
bash ~/dotfiles/scripts/bin/install_brew_packages.sh
bash ~/dotfiles/scripts/bin/install_linters.sh
bash ~/dotfiles/scripts/bin/install_npm_modules.sh
bash ~/dotfiles/scripts/bin/install_pip_modules.sh
bash ~/dotfiles/scripts/bin/install_vim_bundles.sh
