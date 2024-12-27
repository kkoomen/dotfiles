shopt -s expand_aliases

# merge multiple PDF into a single PDF
function mergepdf {
  output_file="$1"
  shift
  gs -q -dBATCH -dNOPAUSE -sDEVICE=pdfwrite -sOutputFile="$output_file" "$@"
}

# Example usage:
# mergepdf merged.pdf file1.pdf file2.pdf file3.pdf

# Generate an `.editorconfig` file
function editorconfig-init {
    if [[ -f .editorconfig ]]; then
        echo "[ERROR] .editorconfig config already exists in $(pwd)"
    else
        echo "# editorconfig.org" > .editorconfig
        echo "root = true" >> .editorconfig
        echo "" >> .editorconfig
        echo "[*]" >> .editorconfig
        echo "indent_style = space" >> .editorconfig
        echo "indent_size = 2" >> .editorconfig
        echo "end_of_line = LF" >> .editorconfig
        echo "charset = utf-8" >> .editorconfig
        echo "trim_trailing_whitespace = true" >> .editorconfig
        echo "insert_final_newline = true" >> .editorconfig
        echo "" >> .editorconfig
        echo "[*.md]" >> .editorconfig
        echo "trim_trailing_whitespace = false" >> .editorconfig
    fi
}

# Lookup a command through chsh
function chsh() {
  local lang=$1
  shift
  local keywords_raw=$1
  shift;
  keywords=$(printf %s "$keywords_raw" "${@/#/+}")
  curl cht.sh/$lang/$keywords
}

# Get current git branch name
function git-branch {
  # Based on: http://stackoverflow.com/a/13003854/170413
  local branch
  if branch=$(git rev-parse --abbrev-ref HEAD 2> /dev/null); then
    if [[ "$branch" == "HEAD" ]]; then
      branch="detached*"
    fi
    git_branch=" ($branch)"
  else
    git_branch=""
  fi

  # Check if the current git directory has uncommitted changes.
  if [[ -n $(git status --porcelain --ignore-submodules 2> /dev/null) ]]; then
    printf "$git_branch $(tput setaf 1)[+]$(tput setaf 7)"
  else
    printf "$git_branch"
  fi

}

# Get the current virtual env name
function get-virtualenv {
  local venv
  if [[ ! -z "$VIRTUAL_ENV" ]]; then
    venv=" ➜  $(tput setaf 4)$(basename "$VIRTUAL_ENV")$(tput setaf 7)"
  else
    venv=""
  fi
  printf "$venv"
}

function prefix-css {
  if [[ -x /usr/local/bin/autoprefixer-cli ]]; then
    echo "Running autoprefixer on $1."
    echo "Saving file as ${2:-$1}."

    /usr/local/bin/autoprefixer-cli --no-remove --no-cascade -o "${2:-$1}" "$1" -b "> 1%, last 4 versions, IE > 10, iOS > 6, safari > 6, Firefox ESR"
  else
    echo "No executable: autoprefixer-cli. Install it via [sudo] npm install -g autoprefixer-cli"
  fi
}

# Usage: START_TIME END_TIME INPUT_FILE OUTPUT_FILE
# Example: cut-mp3 input.mp3 output.mp3 00:00:30 00:02:00
function cut-mp3 {
  ffmpeg -i "$1" -ss "$3" -to "$4" -c copy "${2:-$1}"
}

# Generate 4 random digits
function 4digits {
  n=$((1000 + RANDOM % 9999))
  echo ${n:0:4}
}

# Get current weather forecast based on IP
function weather {
  langcode=$(curl -s ipinfo.io/country)
  curl wttr.in/~$langcode
}

# Generate gitignore file
function gi() {
  curl -sL https://www.toptal.com/developers/gitignore/api/$@
}

# Pastebin
function pb() {
  if [[ -z "$1" ]]; then
    curl -F "clbin=<-" https://clbin.com
  else
    cat "$1" | curl -F "clbin=<-" https://clbin.com
  fi
}


# -----------------------------------------------------------------------------
#
# FZF
#
# -----------------------------------------------------------------------------

# fbr - checkout git branch (including remote branches)
function gc {
  local branches branch
  branches=$(git branch --all | grep -v HEAD) &&
  branch=$(echo "$branches" |
           fzf-tmux -d $(( 2 + $(wc -l <<< "$branches") )) +m) &&
  git checkout $(echo "$branch" | sed "s/.* //" | sed "s#remotes/[^/]*/##")
}

# fshow_preview - git commit browser with previews
alias glNoGraph='git log --color=always --format="%C(auto)%h%d %s %C(magenta)%cr %C(white)➜  %C(blue)%an <%ae> %C(green)%GK%C(auto)" "$@"'
function gl {
  local _gitLogLineToHash="echo {} | grep -o '[a-f0-9]\{7\}' | head -1"
  local _viewGitLogLine="$_gitLogLineToHash | xargs -I % sh -c 'git show --color=always % | diff-so-fancy'"

    glNoGraph |
        fzf --no-sort --reverse --tiebreak=index --no-multi \
            --ansi --preview="$_viewGitLogLine" \
                --header "enter to view, alt-y to copy hash" \
                --bind "enter:execute:$_viewGitLogLine   | less -R" \
                --bind "alt-y:execute:$_gitLogLineToHash | xclip"
}
