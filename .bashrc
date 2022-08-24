# If not running interactively, don't do anything.
case $- in
    *i*) ;;
      *) return;;
esac

# PATH
export PATH="/usr/local/bin:$PATH"
export PATH="/usr/local/sbin:$PATH"
export PATH="/opt/homebrew/bin:$PATH"

export BREW_PREFIX="$(brew --prefix)"

# Base variable exporting.
export EDITOR=vim
export NODE_ENV=development
export TERM=xterm-256color

# virtualenv
export VIRTUAL_ENV_DISABLE_PROMPT=true

# FZF
export FZF_DEFAULT_OPTS='--exact'
export FZF_DEFAULT_COMMAND='rg --files --hidden --follow --glob "!.git/*"'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_DEFAULT_OPTS=$FZF_DEFAULT_OPTS'
 --color=fg:#6c748c,bg:#2e3440,hl:#6face4
 --color=fg+:#c0caf5,bg+:#4c546c,hl+:#68c5cd
 --color=info:#d5b874,prompt:#d97084,pointer:#a389dd
 --color=marker:#87bb7c,spinner:#a389dd,header:#87bb7c'

# Don't put duplicate lines or lines starting with space in the history.
# See bash(1) for more options
export HISTCONTROL=ignoreboth

# Append to the history file, don't overwrite it.
shopt -s histappend

# Use case-insensitive filename globbing.
shopt -s nocaseglob

# For setting history length see HISTSIZE and HISTFILESIZE in bash(1).
export HISTSIZE=100000
export HISTFILESIZE=200000
export HISTTIMEFORMAT='%F %T '
export PROMPT_COMMAND="history -a; $PROMPT_COMMAND"

# Check the window size after each command and, if necessary,
# update the values of LINES and COLUMNS.
shopt -s checkwinsize

# Include all the other bash files.
[[ -f ~/.bash_aliases ]] && . ~/.bash_aliases
[[ -f ~/.bash_functions ]] && . ~/.bash_functions
[[ -f ~/.bash_private ]] && . ~/.bash_private
[[ -f ~/.fzf.bash ]] && . ~/.fzf.bash

# Completions.
[[ -d ~/.completions ]] && . ~/.completions/* > /dev/null 2>&1
[[ -f /usr/local/etc/bash_completion ]] && . /usr/local/etc/bash_completion > /dev/null 2>&1
[[ -d /usr/local/etc/bash_completion.d ]] && . /usr/local/etc/bash_completion.d/* > /dev/null 2>&1

# COMPOSER
export COMPOSER_MEMORY_LIMIT=-1

# Brew
export HOMEBREW_NO_AUTO_UPDATE=1

# Autocorrect typos in path names when using "cd".
shopt -s cdspell

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$BREW_PREFIX/opt/nvm/nvm.sh" ] && . "$BREW_PREFIX/opt/nvm/nvm.sh"  # This loads nvm
[ -s "$BREW_PREFIX/opt/nvm/etc/bash_completion.d/nvm" ] && . "$BREW_PREFIX/opt/nvm/etc/bash_completion.d/nvm"  # This loads nvm bash_completion

# Set PS1 format.
PS1_NORMAL="$(tput setaf 7)┌─ \w\[$(tput setaf 3)\]\$(git-branch)\[$(tput setaf 7)\]\$(get-virtualenv)\n└──── ➜  "
PS1_ERROR="$(tput setaf 1)┌─ $(tput setaf 7)\w\[$(tput setaf 3)\]\$(git-branch)\[$(tput setaf 7)\]\$(get-virtualenv)\n\[$(tput setaf 1)\]└──── ➜  \[$(tput setaf 7)\]"
export PS1="\$([[ \$? == 0 ]] && echo \"$PS1_NORMAL\" || echo \"$PS1_ERROR\")"

# -- PATH: GOLANG
export GOPATH="$HOME/tech/go"
export GOROOT="$BREW_PREFIX/opt/go/libexec"
export PATH="$GOPATH/bin:$GOROOT/bin:$PATH"

# -- PATH: Rust
export PATH="$PATH:$HOME/.cargo/bin"
. "$HOME/.cargo/env"

# -- PATH: Ruby
export PATH="$BREW_PREFIX/opt/ruby/bin:$PATH"
export LDFLAGS="-L$BREW_PREFIX/opt/ruby/lib"
export CPPFLAGS="-I$BREW_PREFIX/opt/ruby/include"
export PKG_CONFIG_PATH="$BREW_PREFIX/opt/ruby/lib/pkgconfig"

# surpress warnings
# see: https://stackoverflow.com/a/59594760
export RUBYOPT='-W0'
if which rbenv > /dev/null; then eval "$(rbenv init -)"; fi

# -- PATH: MacTex
export PATH="$(echo /usr/local/texlive/*/bin/universal-darwin):$PATH"

# -- PATH: Python
export PATH="$(echo $HOME/Library/Python/*/bin):$PATH"
export PATH="$BREW_PREFIX/opt/python@3/Frameworks/Python.framework/Versions/Current/bin:$PATH"

# -- PATH: PHP
export PATH="/usr/local/opt/php/bin:$PATH"
export PATH="/usr/local/opt/php/sbin:$PATH"

# -- PATH: LLVM
# Headers can be found with: g++ -E -x c++ - -v < /dev/null
# and then look for the section: `#include <...> search starts here:`
export PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include:$PATH"
export PATH="$(echo $BREW_PREFIX/Cellar/llvm/*/bin):$PATH"
export LD_LIBRARY_PATH="/Library/Developer/CommandLineTools/usr/lib:$LD_LIBRARY_PATH"

# Swift
export TOOLCHAINS=swift

# Damn Apple who made zsh the default shell on OS X ¯\_(///▽///)_/¯
export BASH_SILENCE_DEPRECATION_WARNING=1

# LANG
export LC_ALL="en_US.UTF-8"

# GPG
export GPG_TTY=$(tty)
