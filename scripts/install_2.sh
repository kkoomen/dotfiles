#!/usr/bin/env bash
#
# This file is used to install the system dependencies.

bash ./../update.sh
bash ./scripts/bin/install_nvm.sh
bash ./scripts/bin/install_brew_packages.sh
bash ./scripts/bin/install_linters.sh
bash ./scripts/bin/install_npm_modules.sh
bash ./scripts/bin/install_pip_modules.sh
bash ./scripts/bin/install_vim_bundles.sh
