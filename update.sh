#!/bin/bash

DOTFILES_DIR=~/dotfiles   # Dotfiles directory.
BACKUP_DIR=~/dotfiles_old # Old dotfiles backup directory.
USERNAME=$(echo $USER)

ORANGE='\033[0;33m'
NC='\033[0m'

# List of files to symlink.
FILES=(
  .bashrc
  .bash_aliases
  .bash_functions
  .bash_profile
  .inputrc
  .weechat/logger.conf
  .weechat/spell.conf
  .weechat/irc.conf
  .weechat/weechat.conf
  .weechat/buflist.conf
  .gitconfig
  .completions
  Library/KeyBindings/DefaultKeyBinding.dict
  .config/mpv/mpv.conf

  # .vimrc
  .config/nvim/init.lua
  .config/nvim/coc-settings.json
  .config/nvim/lua/
)

# Files that must exist.
TOUCH_FILES=()

# Directories that must exist.
TOUCH_DIRS=(
  .config/nvim/
  .config/mpv/
  .ssh/
  .weechat/
  Library/KeyBindings/
)

# Set permissions for executables.
chmod -R 775 $DOTFILES_DIR/bin/
sudo cp $DOTFILES_DIR/bin/* /usr/local/bin

# Create dotfiles_old in homedir if necessary.
echo "[Setup] Creating $BACKUP_DIR to backup any existing dotfiles in /home/$USERNAME"
rm -rf $BACKUP_DIR > /dev/null 2>&1 && mkdir $BACKUP_DIR

# Copy any existing dotfiles to backup folder
for file in "${FILES[@]}"; do
  symlink_file=${file%/} # removes trailing slash
  if [[ -L ~/$symlink_file ]]; then
    rm -f ~/$symlink_file
  elif [[ -e ~/$symlink_file ]]; then
    mv ~/$file $BACKUP_DIR
  fi
done

# Touch directories that have to exist.
for directory in "${TOUCH_DIRS[@]}"; do
  if [[ ! -d ~/$directory ]]; then
    printf "[Setup] touching directory: ${ORANGE}~/$directory${NC}\n"
    mkdir -p ~/$directory
  fi
done

# Touch files that have to exist.
for file in "${TOUCH_FILES[@]}"; do
  if [[ ! -e ~/$file ]]; then
    printf "[Setup] touching file: ${ORANGE}$file${NC}\n"
    touch ~/$file
  fi
done

# Symlink everything from the new dotfiles directory.
for file in "${FILES[@]}"; do
  symlink_file=${file%/} # removes trailing slash
  printf "[Setup] Creating symlink to ${ORANGE}~/$symlink_file${NC} in home directory.\n"
  ln -s $DOTFILES_DIR/$symlink_file ~/$symlink_file
done

# Remaining permissions
[[ -f ~/.ssh/id_rsa ]] && chmod 400 ~/.ssh/id_rsa
[[ ! -f ~/.ssh/config ]] && cp .ssh/config ~/.ssh/

echo "[Setup] done."
