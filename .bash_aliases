shopt -s expand_aliases

# General
alias vim="nvim"
alias ls="ls -lhGp"
alias sl="ls"
alias tree="tree -C"
alias cb="pbcopy"
alias mkdir="mkdir -pv"
alias vi="vim"
alias yt-dl='yt-dlp -f ba -x --audio-quality 0 --audio-format mp3 -o "%(title)s.%(ext)s"'
alias rsync="rsync -azh --inplace --no-whole-file -P --stats --timeout=120"
alias gr='rg --column --line-number --no-heading --fixed-strings --ignore-case --follow --hidden --glob "!.git/*" --color "always" --'
alias nb="pretzel lab"
alias flushdnscache="sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder"
alias texwordcount="texcount -1 -sum=1,1,1,0,0,1,1. -merge -q -nobib"

# Subtitles
alias getsubs="subliminal --opensubtitles $OPENSUBS_USER $OPENSUBS_PASS download -s -f -l en"
alias getsubs-zh="subliminal --opensubtitles $OPENSUBS_USER $OPENSUBS_PASS download -s -f -l zh"

# Network
alias xip="curl ifconfig.me"
alias lip="ipconfig getifaddr en0"

# Dotfiles
alias bashrc="vim ~/.bashrc"
alias vimrc="vim ~/.vimrc"
alias reload="source ~/.bash_profile"
