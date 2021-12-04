shopt -s expand_aliases

# GENERAL
alias mkdir="mkdir -pv"
alias vi="vim"
alias ls="ls -lhG"
alias sl="ls"
alias tree="tree -C"
alias cb="pbcopy"
alias yt-dl='youtube-dl --extract-audio --audio-quality 0 --audio-format mp3 -o "%(title)s.%(ext)s"'
alias make-tar="tar -czvf"
alias rsync="rsync -azh --inplace --no-whole-file -P --stats --timeout=120"
alias gr='rg --column --line-number --no-heading --fixed-strings --ignore-case --follow --hidden --glob "!.git/*" --color "always" --'
alias getsubs='subliminal download -s -f -l en'
alias mpv-16-9='mpv --video-aspect-override=16:9'
alias brew='arch -x86_64 brew'

# NETWORK
alias xip="curl ifconfig.me"
alias lip="ipconfig getifaddr en0"

# DOTFILES
alias bashrc="vim ~/.bashrc"
alias vimrc="vim ~/.vimrc"
alias reload="source ~/.bash_profile"

# DOCKER
alias dsh="docker-compose exec php bash"
