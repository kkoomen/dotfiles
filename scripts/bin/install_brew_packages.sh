#!/usr/bin/env bash
#
# Homebrew
#
# This installs some of the common dependencies needed (or at least desired)
# using Homebrew.


# Setup GOLANG paths
#. ~/.bashrc
#test -d "${GOPATH}" || mkdir "${GOPATH}"
#test -d "${GOPATH}/src/github.com" || mkdir -p "${GOPATH}/src/github.com"

# Check for Homebrew
if test ! $(which brew)
then
  echo "Installing Homebrew."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

brew update && brew upgrade

# Set everything correct
brew doctor

# turn off analytics
brew analytics off

# tap some additional repos
brew tap homebrew/cask-fonts

# Add brew to the commands
export PATH="/usr/local/bin:$PATH"

cask_apps=(
  # LaTeX
  mactex

  # Media players
  vlc

  # Terminals
  iterm2

  # Requirements for curlftpfs
  xquartz

  # Compiling
  cmake

  # Development
  postman

  # Quicklook
  qlvideo

  # Fonts
  font-iosevka
)

for app in "${cask_apps[@]}"; do
  brew install --cask "$app"
done

apps=(
  # Base
  coreutils
  telnet

  # Encryption
  gpg
  pinentry-mac

  # Shell
  bash-completion

  # Image
  imagemagick
  jpeg

  # Searching
  ripgrep

  # Developement
  yarn
  php
  python3
  ruby
  openssl
  composer
  curlftpfs
  go
  typescript
  gh
  swi-prolog

  # Development: C
  ccls
  llvm

  # Terminal
  vim
  wget
  curl
  tree
  htop
  acrogenesis/macchanger/macchanger
  --HEAD\ universal-ctags/universal-ctags/universal-ctags
  ffmpeg
  mpv

  # Omnitagger
  chromaprint

  # IRC
  weechat

  # Compression
  p7zip
  rar
)

for app in "${apps[@]}"; do
  brew install "$app"
done

# Remove outdated versions from the cellar
brew cleanup

echo "Installed homebrew packages."

exit 0
