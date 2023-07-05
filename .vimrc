" Encoding {{{

set encoding=utf-8
set termencoding=utf-8
set fileencoding=utf-8
scriptencoding utf-8

" }}}
" Basic setup {{{

syntax on
filetype plugin indent on
set hidden
set mouse=a
set synmaxcol=9999
set nowrap
set number
set nocursorline
set nocursorcolumn
set title
set ttyfast
set lazyredraw
set clipboard=unnamed
set autoread
set nospell
set spelllang=en_gb,nl
set scrolloff=4
set textwidth=80
set nocompatible
set conceallevel=0
set signcolumn=yes
set updatetime=300
set backspace=indent,eol,start
set foldenable
set redrawtime=4000
set list listchars=tab:\│\ ,trail:•
set completeopt-=preview
set infercase
set ttimeoutlen=50
set wildoptions=tagfile
set display=lastline
set laststatus=2
set noshowmode
set showtabline=2
set nofsync
set diffopt+=vertical
set shell=/bin/bash
set nobackup
set nowritebackup
set noswapfile

" Make our custom aliases available within a non-interactive vim.
" -----------------------------------------------------------------------------
let $BASH_ENV = '~/.bash_aliases'

" }}}
" Search {{{

set ignorecase
set incsearch
set hlsearch

" }}}
" Indentation {{{

set shiftwidth=2
set softtabstop=2
set tabstop=2
set autoindent
set smartindent
set smarttab
set shiftround
set expandtab

" }}}
" Wildmenu {{{

set wildmenu
set wildignorecase
set wildmode=list:longest,full

" }}}
" Omni completion {{{

" Enable omni completion and enable more characters to be available within
" autocomplete by appending to the 'iskeyword' variable.
set iskeyword+=-

" Set all the autocompleters.
" autocmd FileType * setlocal omnifunc=syntaxcomplete#Complete
" autocmd FileType css setlocal omnifunc=csscomplete#CompleteCSS
" autocmd FileType html,markdown setlocal omnifunc=htmlcomplete#CompleteTags
" autocmd FileType javascript,javascript.jsx,jsx,typescript,typescript.jsx setlocal omnifunc=javascriptcomplete#CompleteJS
" autocmd FileType php setlocal omnifunc=phpactor#Complete

" Unset some complete options for optimised completion performance.
" i   Scan the current and included files.
set complete-=i

" }}}
" Undo history {{{

set undofile                 " Save undo's after file closes.
set undodir=~/.vim/undo,/tmp " Where to save undo histories.
set undolevels=1000          " How many undos.
set undoreload=10000         " Number of lines to save for undo.
set history=1000             " Sets how many lines of history vim has to remember.

" }}}
" Filetypes {{{

autocmd BufRead,BufNewFile *.pl setlocal filetype=prolog

augroup drupal
  autocmd!
  autocmd BufRead,BufNewFile *.blade.php setlocal filetype=php
  autocmd BufRead,BufNewFile *.theme setlocal filetype=php
  autocmd BufRead,BufNewFile *.module setlocal filetype=php
  autocmd BufRead,BufNewFile *.install setlocal filetype=php
  autocmd BufRead,BufNewFile *.test setlocal filetype=php
  autocmd BufRead,BufNewFile *.inc setlocal filetype=php
  autocmd BufRead,BufNewFile *.profile setlocal filetype=php
  autocmd BufRead,BufNewFile *.view setlocal filetype=php
  autocmd BufRead,BufNewFile *.drush setlocal filetype=php
augroup END

augroup bash
  autocmd!
  autocmd BufNewFile,BufRead *.bash_* setlocal ft=sh
  autocmd BufNewFile,BufRead *.sh setlocal ft=sh
augroup END

augroup javascript
  autocmd!
  autocmd BufRead,BufNewFile *.mdx,*.plop setlocal filetype=javascript
  autocmd BufRead,BufNewFile *.tsx setlocal filetype=typescript.jsx
  autocmd FileType coffee setlocal filetype=javascript.coffee
  autocmd BufRead,BufNewFile *.prisma setlocal filetype=graphql
augroup END

augroup latex
  autocmd!
  autocmd BufRead,BufNewFile *.tex setlocal filetype=tex
augroup END

augroup rc
  autocmd!
  autocmd BufRead,BufNewFile .babelrc,.stylelintrc,.prettierrc,.htmlhintrc setlocal filetype=json
augroup END

augroup minified
  autocmd!
  autocmd BufRead,BufNewFile *.min.* setlocal syntax=off
augroup END

augroup styles
  autocmd!
  " Format options have impact when formatting code with the 'gq' binding.
  " Default: crqlo (see ':h fo-table' for more info)
  autocmd FileType * set formatoptions=crql
  autocmd FileType text,markdown,tex,plaintex set formatoptions+=t

  autocmd BufRead,BufNewFile *.min.* setlocal syntax=off
  autocmd FileType java,python,go,apache,tex,plaintex,rust setlocal tabstop=4 shiftwidth=4 softtabstop=4
  autocmd FileType php setlocal iskeyword-=-
  autocmd FileType css,less,scss setlocal iskeyword+=.
  autocmd FileType vim setlocal iskeyword+=: foldmethod=marker
  autocmd FileType text,markdown,tex,plaintex setlocal spell conceallevel=0
  autocmd FileType json syntax match Comment +\/\/.\+$+
augroup END


" }}}
" Functions {{{

" Helpers {{{2

function s:ShowCursorHighlightGroups() abort
  let l:s = synID(line('.'), col('.'), 1)
  echo synIDattr(l:s, 'name') . ' -> ' . synIDattr(synIDtrans(l:s), 'name')
endfunction

function s:GetVisualModeContent() abort
  let [line_start, column_start] = getpos("'<")[1:2]
  let [line_end, column_end] = getpos("'>")[1:2]
  let l:lines = getline(line_start, line_end)

  if len(l:lines) == 0
    return ''
  endif

  let l:lines[-1] = l:lines[-1][: column_end - (&selection == 'inclusive' ? 1 : 2)]
  let l:lines[0] = l:lines[0][column_start - 1:]
  return join(l:lines, "\n")
endfunction

function s:PrepareSubstitute(mode) range abort
  let l:expr = ''

  if a:mode ==# 'n'
    let l:expr = expand('<cword>')
  elseif a:mode ==# 'v'
    let l:expr = <SID>GetVisualModeContent()
  endif

  for l:char in split('.$^[]', '\zs')
    let l:expr = substitute(l:expr, '\'.l:char, '\\'.l:char, 'g')
  endfor
  call feedkeys(":%s/" . l:expr . "//g\<Left>\<Left>")
endfunction

function s:DeleteTrailingLeadingLines() abort
  " Delete empty lines at the start of the buffer.
  if getline(1) !~ '\S'
    keepjumps call execute('normal! gg"_dip', 'silent!')
  endif

  " Delete empty lines at the end of the buffer.
  if getline('$') !~ '\S'
    keepjumps call execute('normal! G"_dip', 'silent!')
  endif
endfunction

function s:HelpWindow(args) abort
  if winwidth('.') >= 164
    call execute('vertical h ' . a:args)
    call execute('vertical resize 84')
  else
    call execute('h ' . a:args)
  endif
endfunction

function s:GitBlame(line1, line2, args) abort
  let l:msg = join(systemlist("git -C " . shellescape(expand('%:p:h')) . " blame -L " . a:line1 . "," . a:line2 . " " . a:args . " --date " . '"format:%Y-%m-%d %H:%M:%S"' . " -- " . expand('%:t')), "\n")
  if stridx(l:msg, 'fatal') == -1
    " Regex groups:
    " \1: revision
    " \2: author
    " \3: time
    " \4: line number
    " \5: line contents
    echo substitute(
          \ l:msg,
          \ '\([0-9a-f]\+\) (\(.\{-}\) \(\d\+-\d\+-\d\+ \d\+:\d\+:\d\+\) \(\d\+\))\%( \(.*\)\)\?',
          \ '[\1] last modified by \2 at \3',
          \ 'g'
          \ )
  endif
endfunction

function! s:SpaceToTab(str) abort
  let l:remainder = len(a:str) % shiftwidth()
  return repeat("\t", len(a:str) / shiftwidth()) . repeat(' ', l:remainder)
endfunction

function! s:GetGitRoot() abort
  let l:git_root = system('git -C ' . shellescape(expand('%:p:h')) . ' rev-parse --show-toplevel')
  if v:shell_error == 0
    return split(l:git_root, '\n')[0]
  else
    return ''
  endif
endfunction

function! s:GetRelativeBufferPathInGitDirectory() abort
  let l:git_root = <SID>GetGitRoot()

  if l:git_root == ''
    return expand('%:p')
  endif

  return substitute(
        \ expand('%:p'),
        \ trim(<SID>GetGitRoot()) . '/',
        \ '',
        \ 'g'
        \ )
endfunction

function! s:CompileLatexProject() abort
  let l:mainfile = 'main.tex'
  let l:git_root = <SID>GetGitRoot()
  if l:git_root != '' && filereadable(l:git_root . '/' . l:mainfile)
    " Compile current project based on the git root directory.
    execute('AsyncRun xelatex -shell-escape ' . l:git_root . '/' .  l:mainfile . ' -output-directory=' . l:git_root)
  else
    " Compile current file.
    execute('AsyncRun xelatex -shell-escape %:p -output-directory=%:h')
  endif
endfunction

function! s:OpenLatexPDF() abort
  let l:mainfile = 'main.pdf'
  let l:git_root = <SID>GetGitRoot()
  if l:git_root != '' && filereadable(l:git_root . '/' . l:mainfile)
    " Open current project's PDF based on the git root directory.
    execute('AsyncRun! open -a Skim ' . l:git_root . '/' . l:mainfile)
  else
    " Open current file's PDF.
    execute('AsyncRun! open -a Skim %:r.pdf')
  endif
endfunction

" }}}

" Commands {{{2

function s:Find(mode) range abort
  let l:expr = ''

  if a:mode ==# 'n'
    let l:expr = expand('<cword>')
  elseif a:mode ==# 'v'
    let l:expr = <SID>GetVisualModeContent()
  endif

  call feedkeys(':Find ' . l:expr . "\<CR>")
endfunction

" Rename a buffer.
function s:Rename(bang, args) abort
  let l:oldfile = expand('%:p')
  let l:newfile = a:args
  setlocal modifiable
  call execute(':saveas' . a:bang . ' ' . l:newfile)
  call delete(l:oldfile)
  call execute(':' . bufnr('$') . 'bw')
endfunction

function s:Open(bang, args) abort
  let l:filename = a:args
  call system('open ' . l:filename)
endfunction

" Remove a file.
function s:Remove(args) abort
  let l:success = delete(a:args) == 0
  " If we're deleting the current buffer, then remove the buffer itself.
  if l:success == v:true && a:args == expand('%')
    bdelete!
  endif
  echo 'Remove: ' . a:args . ' ' . (l:success ? 'succeeded' : 'failed')
endfunction

function s:CSSFormat() abort
  " Save the current window state.
  let l:winview = winsaveview()

  " Remove all lines with nothing but spaces.
  keepjumps call execute('g/^[\n[:space:]]*$/d _', 'silent!')

  " Add lines in-between selector blocks.
  keepjumps call execute('%s/\%(#.\{-}\)\@<!\([};]\)\(.\{-}\%(\/\/[^\n]*\|\/\*.\{-}\*\/[^\n]*\)\)\?\%(\_[^;{}]\{-}{\)\@=/\1\2\r/g', 'silent!')

  " Add lines in-between closing bracket and variables.
  keepjumps call execute('%s/\(}\)\%(\_[[:space:]]\{-}\$\)\@=/\1\r/g', 'silent!')

  " Add lines in-between @import and other expressions starting with '@'.
  keepjumps call execute('%s/}\n@\([[:alpha:]]\+\)/}\r\r@\1/g', 'silent!')

  " Remove all extra lines between closing brackets.
  keepjumps call execute('g/}[}\n[:space:]]*}/s/\n^[\n[:space:]]*$//g', 'silent!')

  " Remove all extra lines
  keepjumps call execute('%s/\n\{3,}/\r\r/g', 'silent!')

  " Ensure every property is spaced correctly.
  keepjumps call execute('%s/^\(\s*[[:alnum:]-]\+\)\s*:\s*\(\_[^:]\{-};\)$/\1: \2/g', 'silent!')

  " Ensure selectors and opening brackets are a single whitespace.
  keepjumps call execute('%s/\%(#\)\@<!\s*{/ {/g', 'silent!')

  call <SID>DeleteTrailingLeadingLines()

  " Restore the window view.
  call winrestview(l:winview)

  " Remove search highlighting
  call execute('silent! noh')
endfunction

function! s:IndentCode() abort
  " Save the current window view.
  let l:winview = winsaveview()

  " Indent code.
  keepjumps execute('normal! gg=G')

  " Restore the window view.
  call winrestview(l:winview)
endfunction

function s:PHPConvertArrays() abort
  let l:winview = winsaveview()
  while search('\m\(\w\)\@<!\carray\s*(') > 0
    call execute("normal! dt(%r]\<C-O>r[")
  endwhile
  call winrestview(l:winview)
endfunction

" }}}

" Hooks {{{2

function s:OnBufWritePre() abort
  if !exists('b:disable_hook_bufprewrite')
    " Save the current window view.
    let l:winview = winsaveview()

    call <SID>DeleteTrailingLeadingLines()

    " Execute commands only for non-test files.
    let l:ignore_pattern = '\m\(vader\|gitcommit\)'
    if expand('%:t') !~# l:ignore_pattern

      " Delete trailing whitespaces for each line.
      keepjumps call execute('%s/\s\+$//ge', 'silent!')

      " We want to 'retab!' the whole file, but this will convert spaces to tabs
      " inside comments when using tabs. To fix this we will check if tabs are
      " used, then convert everything to spaces and then convert the indentation
      " to tabs.
      if &expandtab == v:false
        setlocal expandtab
        keepjumps call execute('%retab!', 'silent!')
        keepjumps call execute('%s/^\s\+/\=<SID>SpaceToTab(submatch(0))/', 'silent!')
        call execute('silent! noh')
        setlocal noexpandtab
      else
        keepjumps call execute('%retab!', 'silent!')
      endif
    endif

    " Restore the window view.
    call winrestview(l:winview)
  endif
endfunction

function s:OnBufReadPost() abort
  " Set the last edit position.
  if line("'\"") > 0 && line("'\"") <= line("$") |
    execute("normal! g`\"") |
  endif

  " Disable syntax highlighting for files larger than 1MB.
  let l:bytes = getfsize(expand(@%))
  if l:bytes > 1024 * 1024
    set syntax=off
    let b:statusline_show_syntax_disabled = 1
  endif
endfunction

function! s:OnVimEnter() abort
  return

  " Run PlugUpdate every week automatically when entering Vim.
  if exists('g:plug_home')
    let l:filename = printf('%s/.vim_plug_update', g:plug_home)
    if filereadable(l:filename) == 0
      call writefile([], l:filename)
    endif

    let l:this_week = strftime('%Y_%U')
    let l:contents = readfile(l:filename)
    if index(l:contents, l:this_week) < 0
      call execute('PlugUpdate')
      call writefile([l:this_week], l:filename, 'a')
    endif
  endif
endfunction

" }}}

" }}}
" Hooks {{{

augroup hooks
  autocmd!
  autocmd BufWritePre *                     call <SID>OnBufWritePre()
  autocmd BufReadPost *                     call <SID>OnBufReadPost()
  autocmd VimEnter    *                     call <SID>OnVimEnter()
  autocmd BufWritePre *.{css,scss,less}     call <SID>CSSFormat()
  " autocmd BufWritePost *.py                 :PythonAutoflake
  " autocmd BufWritePre *.ts,*.tsx,*.js,*.jsx :OrganizeImports
augroup END

" }}}
" Commands {{{

" Global {{{2

" Rename current buffer.
command! -nargs=1 -complete=file Rename call <SID>Rename('<bang>', '<args>')

" Open a file using the 'open <filename>' command on OSX.
command! -nargs=1 -complete=file Open call <SID>Open('<bang>', '<args>')

" Remove a file.
command! -nargs=1 -complete=file Remove call <SID>Remove('<args>')

" Display highlight groups under the cursor.
command! -nargs=0 ShowHighlightGroups call <SID>ShowCursorHighlightGroups()

" Set the absolute path of the current buffer to the system clipboard.
" 'BP' refers to 'Buffer Path'.
command! -nargs=0 BP :let @+=expand('%:p') | echo @*

" Set the path of the current buffer relative to its git diretory to the
" system clipboard. 'GBP' refers for 'Git Buffer Path'.
command! -nargs=0 GBP :let @+=<SID>GetRelativeBufferPathInGitDirectory() | echo @*

" Git Blame
"
" current line
" :GB
"
" range
" :7,13GB
" :,+5GB
" :?foo?,$GB
" :'<,'>GB
"
" full buffer
" :%GB
"
" earlier history
" :GB HEAD~1
command! -nargs=? -range GB call <SID>GitBlame('<line1>', '<line2>', '<args>')


" Open help menu in a 80-column vertical window.
command! -nargs=* -complete=help H call <SID>HelpWindow('<args>')

" }}}

" Language-specific {{{2

" Format (LE|SA|C)SS.
command! -nargs=0 CSSFormat call <SID>CSSFormat()

" Convert PHP <= 5.3 syntax array() to [].
command! -nargs=0 PHPConvertArrays call <SID>PHPConvertArrays()

" Beautify CSS
command! -nargs=0 CSSBeautify call <SID>CSSBeautify()

" Convert function(){} to () => {}.
command! -nargs=0 JSFuncToArrow :%s/function\s*\%(\w\+\)\?\s*(\(.\{-}\))\_\s*{/(\1) => {/g | silent! noh

" Convert () => {} to function(){}.
command! -nargs=0 JSArrowToFunc :%s/\(\%(const\|let\|var\) \(\w\+\)\s*=\s*\)\?(\(.\{-}\))\s*=>\s*[{(]\+/\1function \2(\3) {/g | silent! noh

" Run autoflake on the current python file
command! -nargs=0 PythonAutoflake :call system('autoflake --in-place --remove-unused-variables --remove-all-unused-imports ' . expand('%')) | :checktime

" }}}

" }}}
" Mappings {{{

" Leader key
" ------------------------------------------------------------------------------
let g:mapleader = "\<Space>"

" Run 'checktime' when the cursor stops moving.
autocmd CursorHold,CursorHoldI * checktime

" When going down by arrow or j/k, go down the next line visually.
map j gj
map k gk
map <Down> gj
map <Up> gk

" Buffers
" ------------------------------------------------------------------------------
nnoremap <silent> Z :bprev<CR>
nnoremap <silent> X :bnext<CR>
nnoremap <silent> Q :bw<CR>

" LaTeX compilation
" ------------------------------------------------------------------------------
autocmd FileType tex,plaintex nmap <buffer> R :call <SID>CompileLatexProject()<CR>
autocmd FileType tex,plaintex nmap <buffer> T :call <SID>OpenLatexPDF()<CR>

" Moving lines up or down
" ------------------------------------------------------------------------------
nnoremap <silent> <C-Down> :m .+1<CR>==
nnoremap <silent> <C-Up> :m .-2<CR>==
inoremap <silent> <C-Down> <Esc>:m .+1<CR>==gi
inoremap <silent> <C-Up> <Esc>:m .-2<CR>==gi
vnoremap <silent> <C-Down> :m '>+1<CR>gv=gv
vnoremap <silent> <C-Up> :m '<-2<CR>gv=gv

" Set pastetoggle
" ------------------------------------------------------------------------------
set pastetoggle=<F2>

" Rot13
" ------------------------------------------------------------------------------
nnoremap <silent> <F6> ggg?G<CR>

" Space bar un-highligths search
" ------------------------------------------------------------------------------
nnoremap <silent> <nowait> <Space> :silent! noh<CR>

" Search for the word under the cursor using Find.
" ------------------------------------------------------------------------------
nnoremap <buffer> <nowait> <silent> <Leader>f :call <SID>Find('n')<CR>
vnoremap <buffer> <nowait> <silent> <Leader>f :call <SID>Find('v')<CR>

" Allow saving of files as sudo when I forgot to start vim using sudo
" ------------------------------------------------------------------------------
cnoremap w!! w !sudo tee > /dev/null %

" Spell check
" ------------------------------------------------------------------------------
nnoremap <Leader>sp :setlocal spell!<CR>

" Remove ^M
" ------------------------------------------------------------------------------
noremap <Leader>m :%s/\r//g<CR>

" Map ; to : for simplicity & efficiency
" ------------------------------------------------------------------------------
noremap ; :

" Map ; to :B in combination with the vis.vim plugin
" ------------------------------------------------------------------------------
" The vis.vim plugin allows us to apply a command in visual-block mode only to
" the selected block instead of the whole line. To do so, every command has to
" be prefixed with 'B' which ends up in: '<, '>B [command].
" ------------------------------------------------------------------------------
vnoremap ; :B<space>

" Selection
" ------------------------------------------------------------------------------
" Make selection stay after keypress.
" ------------------------------------------------------------------------------
noremap > >gv
noremap < <gv

" Typo's while saving
" ------------------------------------------------------------------------------
" Avoid saving files like ; and w; and other typos
" ------------------------------------------------------------------------------
cnoremap w; w
cnoremap w: w
cnoremap W; w
cnoremap W: w

" }}}
" Plugins: Emmet {{{

" After the leader key you should always enter a comma to trigger emmet.
let g:user_emmet_leader_key='<C-f>'
let g:user_emmet_settings = {
      \   'typescript.jsx' : {
      \     'extends': 'jsx',
      \   },
      \   'javascript.jsx' : {
      \     'extends': 'jsx',
      \   },
      \ }


" }}}
" Plugins: HTML Close Tag {{{

let g:closetag_filenames = "*.html,*.xhtml,*.phtml,*.tpl,*.twig,*.htm,*.php,*.pug,*.jsx,*.js,*.mdx,*.plop,*.tsx,*.erb,*.vue"

" }}}
" Plugins: Templates {{{

let g:username = 'Kim Koomen'
let g:email = 'koomen@pm.me'
let g:license = 'MIT'

let g:templates_user_variables = [
      \   ['FILE_OR_DIRECTORY', 'GetFileOrDirectory'],
      \   ['DATE_dd_MM_YY', 'Date_ddMMYYYY'],
      \ ]

function! Date_ddMMYYYY()
  return strftime("%b %d %Y")
endfunction

function! GetFileOrDirectory()
  " A structure we have with React apps is: dir/index.jsx
  " and if we have this, we want the index.jsx have the directory name.
  let l:filename = expand('%:t:r')
  let l:directory = expand('%:p:h:t')
  if l:filename == 'index'
    return l:directory
  else
    return l:filename
  endif
endfunction

" }}}
" Plugins: indentLine {{{

let g:indentLine_char = '│'
let g:markdown_syntax_conceal = 0
let g:vim_json_conceal = 0
let g:indentLine_fileTypeExclude = ['tex']

" }}}
" Plugins: tComment {{{

map <C-c> g>c<CR>
vmap <C-c> g>b<CR>

map <C-x> g<c<CR>
vmap <C-x> g<b<CR>

" }}}
" Plugins: Gutentags {{{

" Setup the directory to store all the tags.lock / tags.temp files.
let g:gutentags_cache_dir = expand('~/.cache/vim/ctags/')

" Add a custom command for clearing all the cached tags.
command! -nargs=0 GutentagsClearCache call system('rm ' . g:gutentags_cache_dir . '/*')

" Disable the default project root markers and add our own.
let g:gutentags_add_default_project_roots = 0
let g:gutentags_project_root = ['package.json', '.git']

" If set to 1, Gutentags will start generating the tag file when a new project
" is open. A new project is considered open when a buffer is created for a file
" whose corresponding tag file has not been 'seen' yet in the current Vim
" session -- which pretty much means when you open the first file in a given
" source control repository.
let g:gutentags_generate_on_new = 1

" If set to 1, Gutentags will start generating an initial tag file if a file is
" open in a project where no tags file is found.
let g:gutentags_generate_on_missing = 1

" If set to 1, Gutentags will update the current project's tag file when a file
" inside that project is saved
let g:gutentags_generate_on_write = 1

" If set to 1, Gutentags will start generating the tag file even if there's no
" buffer currently open, as long as the current working directory (as returned
" by |:cd|) is inside a known project.  This is useful if you want Gutentags to
" generate the tag file right after opening Vim.
let g:gutentags_generate_on_empty_buffer = 0

let g:gutentags_ctags_extra_args = [
      \ '--tag-relative=yes',
      \ '--fields=+ailmnS',
      \ ]

let g:gutentags_ctags_exclude = [
      \ '*.git', '*.svg', '*.hg',
      \ '*/tests/*',
      \ 'build',
      \ 'env',
      \ 'dist',
      \ '*sites/*/files/*',
      \ 'bin',
      \ 'node_modules',
      \ 'bower_components',
      \ 'cache',
      \ 'compiled',
      \ 'docs',
      \ 'example',
      \ 'bundle',
      \ 'vendor',
      \ '*.md',
      \ '*-lock.json',
      \ 'composer.phar',
      \ '*.lock',
      \ '*bundle*.js',
      \ '*build*.js',
      \ '.*rc*',
      \ '*.json',
      \ '*.min.*',
      \ '*.map',
      \ '*.bak',
      \ '*.zip',
      \ '*.pyc',
      \ '*.class',
      \ '*.sln',
      \ '*.Master',
      \ '*.csproj',
      \ '*.tmp',
      \ '*.csproj.user',
      \ '*.cache',
      \ '*.pdb',
      \ 'tags*',
      \ 'cscope.*',
      \ '*.css',
      \ '*.less',
      \ '*.scss',
      \ '*.exe', '*.dll',
      \ '*.mp3', '*.ogg', '*.flac',
      \ '*.swp', '*.swo',
      \ '*.bmp', '*.gif', '*.ico', '*.jpg', '*.png',
      \ '*.rar', '*.zip', '*.tar', '*.tar.gz', '*.tar.xz', '*.tar.bz2',
      \ '*.pdf', '*.doc', '*.docx', '*.ppt', '*.pptx',
      \ ]

" }}}
" Plugins: Surround {{{

" To emulate a modern editor at its best, we want to remap x to Sx for
" efficiency and simplicity. The vim-surround plugin is mapping almost every
" single character because it prefixes it with 'S', but we only specify will
" specify the ones we might need, because we do not want to remap default
" built-in vim mappings.

let g:visual_surround_characters = [
      \ '{', '}',
      \ '[', ']',
      \ '(', ')',
      \ '"', "`", "'",
      \ '%', '-', '_', '*'
      \ ]
for char in g:visual_surround_characters
  keepjumps call execute('vmap ' . char . ' S' . char)
endfor

" }}}
" Plugins: FZF {{{

" Set runtime path containing useful key bindings and fuzzy completions.
set rtp+=/usr/local/opt/fzf

" Set a mapping to toggle FZF
nnoremap <C-p> :FZF<CR>

" fzf.vim plugin mappings
noremap <Leader>b :BCommits<CR>
noremap <Leader>c :Commits<CR>

" let g:fzf_layout = { 'window': 'enew' }
let g:fzf_layout = {'down': '35%'}
let g:fzf_tags_command = 'ctags --extra=+f -R'

" Hide statusline
autocmd! FileType fzf set laststatus=0 noshowmode noruler
      \| autocmd BufLeave <buffer> set laststatus=2 showmode ruler


" Use ripgrep with FZF
" Example usage -> :Find <query>
"
" Options
" --column: Show column number
" --line-number: Show line number
" --no-heading: Do not show file headings in results
" --fixed-strings: Search term as a literal string
" --ignore-case: Case insensitive search
" --hidden: Search hidden files and folders
" --follow: Follow symlinks
" --glob: Additional conditions for search
" --color: Search color options
command! -bang -nargs=* Find call fzf#vim#grep('rg --column --line-number --no-heading --fixed-strings --follow --hidden --glob "!{.git/*,*.lock}" --color "always" -- ' . shellescape(<q-args>), 1, <bang>0)
command! -bang -nargs=* IFind call fzf#vim#grep('rg --column --line-number --no-heading --fixed-strings --ignore-case --follow --hidden --glob "!{.git/*,*.lock}" --color "always" -- ' . shellescape(<q-args>), 1, <bang>0)

" }}}
" Plugins: EditorConfig {{{

" let g:EditorConfig_disable_rules = ['max_line_length', 'indent_size', 'tab_width']
let g:EditorConfig_disable_rules = ['max_line_length']

" }}}
" Plugins: Readdir {{{

" Disable netrw because we use https://github.com/kkoomen/vim-readdir
let loaded_netrwPlugin = 1

" Show hidden files as well.
let g:readdir_hidden = 2

" }}}
" Plugins: DoGe {{{

let g:doge_mapping = '<C-d>'

" }}}
" Plugins: coc {{{

let g:coc_global_extensions = [
      \ 'coc-tsserver',
      \ 'coc-html',
      \ 'coc-css',
      \ 'coc-pyright',
      \ 'coc-phpls',
      \ 'coc-yaml',
      \ 'coc-json',
      \ 'coc-vimlsp',
      \ 'coc-emmet',
      \ 'coc-tag',
      \ 'coc-solargraph',
      \ 'coc-vetur',
      \ 'coc-eslint',
      \ 'coc-prettier',
      \ 'coc-clangd',
      \ 'coc-java',
      \ 'coc-rust-analyzer',
      \ 'coc-texlab',
      \ ]

function! s:show_documentation()
  if (index(['vim','help'], &filetype) >= 0)
    execute 'H ' . expand('<cword>')
  elseif CocAction('hasProvider', 'hover')
      call CocActionAsync('doHover')
  else
    call feedkeys('K', 'in')
  endif
endfunction

" Use K to show documentation in preview window.
nnoremap <silent> K :call <SID>show_documentation()<CR>

" Use to format current buffer.
command! -nargs=0 Format :call CocAction('format')

" Re-indent code.
noremap <Leader>i :call CocAction('format')<CR>

" Use to organize imports of the current buffer.
command! -nargs=0 OrganizeImports :call CocAction('runCommand', 'editor.action.organizeImport')
command! -nargs=0 EslintFix :call CocAction('runCommand', 'eslint.executeAutofix')

nmap <silent> gd <Plug>(coc-definition)
nmap <silent> gi <Plug>(coc-implementation)
nmap <silent> gr <Plug>(coc-references)
nmap <silent> gru <Plug>(coc-references-used)
nmap <leader>n <Plug>(coc-rename)

" Use <CR> to confirm completion
" inoremap <expr> <cr> coc#pum#visible() ? coc#_select_confirm() : "\<CR>"
" Make <CR> to accept selected completion item or notify coc.nvim to format
" <C-g>u breaks current undo, please make your own choice
inoremap <silent><expr> <CR> coc#pum#visible() ? coc#pum#confirm()
                              \: "\<C-g>u\<CR>\<c-r>=coc#on_enter()\<CR>"

" }}}
" Plugins: Lightline {{{

function! LightlineFilename() abort
  return expand('%:p') !=# '' ? expand('%:p') : '[No Name]'
endfunction

function! LightlineReadonly() abort
  return &readonly ? '' : ''
endfunction

function! LightlineGitBranch() abort
  if exists('*gitbranch#name') == v:false
    return ''
  endif
  let l:branch = gitbranch#name()
  return l:branch !=# '' ? ' ' . l:branch : ''
endfunction

function! LightlineIndent() abort
  return (&expandtab ? 'spaces' : 'tabs') . ':' . shiftwidth()
endfunction

function! LightlineGutentags() abort
  if exists('*gutentags#statusline')
    return gutentags#statusline('', ':running')
  endif
  return ''
endfunction

function LightlineModified() abort
  return &modifiable && &modified ? '+' : ''
endfunction

function LightlineFileFormat() abort
  return &fileformat
endfunction

function LightlineFileEncoding() abort
  return &fenc !=# '' ? &fenc : &enc
endfunction

function LightlineFiletype() abort
  return &ft !=# '' ? &ft : 'no ft'
endfunction

function LightlineWordCount() abort
  if index(['', 'text', 'markdown', 'tex', 'asciidoc', 'help', 'mail', 'org', 'rst'], &ft) < 0
    return ''
  endif

  if has_key(wordcount(), 'visual_words')
    let g:word_count = wordcount().visual_words . '/' . wordcount().words " count selected words
  else
    let g:word_count = wordcount().cursor_words . '/' . wordcount().words " or shows words 'so far'
  endif

  return 'words:' . g:word_count . ', chars:' . (wordcount().chars - 1)
endfunction

let g:lightline = {
      \  'colorscheme': 'gruvbox_material',
      \  'active': {
      \    'left': [
      \      ['mode', 'paste'],
      \      ['gitbranch', 'readonly', 'filename', 'modified'],
      \    ],
      \    'right': [
      \      ['lineinfo'],
      \      ['percent'],
      \      ['gutentags', 'wordcount', 'indent', 'fileformat', 'fileencoding', 'filetype'],
      \    ],
      \  },
      \  'inactive': {
      \    'left': [['filename']],
      \    'right': []
      \  },
      \  'component': {
      \    'lineinfo': ' %3l/%L:%-2v',
      \  },
      \  'component_function': {
      \    'gitbranch': 'LightlineGitBranch',
      \    'readonly': 'LightlineReadonly',
      \    'filename': 'LightlineFilename',
      \    'modified': 'LightlineModified',
      \    'gutentags': 'LightlineGutentags',
      \    'wordcount': 'LightlineWordCount',
      \    'indent': 'LightlineIndent',
      \    'fileformat': 'LightlineFileFormat',
      \    'fileencoding': 'LightlineFileEncoding',
      \    'filetype': 'LightlineFiletype',
      \  },
      \  'separator': {'left': '', 'right': ''},
      \  'subseparator': {'left': '', 'right': ''},
      \  'tabline': {'left': [['buffers']], 'right': [['close']]},
      \  'component_expand': {'buffers': 'lightline#bufferline#buffers'},
      \  'component_type': {'buffers': 'tabsel'},
      \}

let g:lightline#bufferline#unnamed = '[No name]'
let g:lightline#bufferline#filename_modifier = ':t'
let g:lightline#bufferline#shorten_path = 0
let g:lightline#bufferline#smart_path = 0
let g:lightline#bufferline#filename_modifier = ':p:gs?/\([^/]\+/\)*\([^/]\+/[^/]\+\)$?\2?'

" }}}
" Plugins: UltiSnips {{{

let g:UltiSnipsExpandTrigger="<Tab>"
let g:UltiSnipsJumpForwardTrigger="<Tab>"
let g:UltiSnipsJumpBackwardTrigger="<S-Tab>"
let g:UltiSnipsSnippetDirectories = ['UltiSnips']

" }}}
" Plugins: Caser {{{

let g:caser_prefix = 'ac'

" }}}
" Plugins: AsyncRun {{{

function! s:CloseAsyncRunQuickfixWindow()
  if g:asyncrun_code == 0
    cclose
  endif
endfunction

let g:asyncrun_open = 6
autocmd User AsyncRunStop call <SID>CloseAsyncRunQuickfixWindow()

" }}}
" Plugins {{{

call plug#begin('~/.vim/plugged')
Plug 'AndrewRadev/splitjoin.vim'
Plug 'SirVer/ultisnips'
Plug 'Yggdroot/indentLine'
Plug 'alvan/vim-closetag'
Plug 'arthurxavierx/vim-caser'
Plug 'chrisbra/csv.vim'
Plug 'editorconfig/editorconfig-vim'
Plug 'godlygeek/tabular'
Plug 'honza/vim-snippets'
Plug 'itchyny/lightline.vim'
Plug 'itchyny/vim-gitbranch'
Plug 'jiangmiao/auto-pairs'
Plug 'junegunn/fzf', { 'do': { -> fzf#install() } }
Plug 'junegunn/fzf.vim'
Plug 'junegunn/vader.vim'
Plug 'ludovicchabant/vim-gutentags'
Plug 'mattn/emmet-vim'
Plug 'mengelbrecht/lightline-bufferline'
Plug 'mileszs/ack.vim'
Plug 'neoclide/coc.nvim', { 'branch': 'release' }
Plug 'pechorin/any-jump.vim'
Plug 'sainnhe/gruvbox-material'
Plug 'sickill/vim-pasta'
Plug 'skywind3000/asyncrun.vim'
Plug 'tomtom/tcomment_vim'
Plug 'tpope/vim-endwise'
Plug 'tpope/vim-surround'
Plug 'tpope/vim-fugitive'
Plug 'ivanov/vim-ipython'
Plug 'git@github.com:kkoomen/vim-jime'
Plug 'git@github.com:kkoomen/vim-doge', { 'do': 'npm i --no-save && npm run build:binary:unix' }
Plug 'git@github.com:kkoomen/vim-readdir'
call plug#end()

" }}}
" Color scheme {{{

let g:gruvbox_underline = 1
let g:gruvbox_bold = 1
let g:gruvbox_italic = 1
let g:gruvbox_italicize_strings = 0
let g:gruvbox_italicize_comments = 1
let g:gruvbox_material_diagnostic_text_highlight = 1
let g:gruvbox_material_background = 'soft'
let g:gruvbox_material_better_performance = 1

set background=dark
set termguicolors
colorscheme gruvbox-material

" }}}
" Custom Highlighting {{{

" Only highlight the color column when the line is expanding the 80th column.
highlight! ColorColumn ctermbg=red ctermfg=white guibg=#ea6962 guifg=#252423
call matchadd('ColorColumn', '\%81v.', 100)

" Additional java highlighting
let g:java_highlight_all = 1
let g:java_highlight_functions = 1

" Markdown codeblocks
let g:markdown_fenced_languages = [
      \ 'python', 'javascript', 'typescript', 'php', 'rust', 'sh', 'bash', 'go',
      \ 'ruby', 'c', 'cpp', 'vim', 'viml=vim', 'dosini', 'ini=dosini', 'html', 'css',
      \ ]

" }}}
" SWI-Prolog {{{

function! s:SwiplQuery() abort
  let l:curr_line = getline(line('.')) . "\n"

  " Matches '%?-' and '% ?-'
  let l:query_pattern = '^\s*%\s\??-\s*'
  if l:curr_line =~# l:query_pattern
    let l:query = substitute(l:curr_line, l:query_pattern, '', 'g')

    set splitbelow
    let l:term = term_start(['swipl', '-O', '-q', '-f', expand('%:p')], {
          \ 'term_name': 'swipl',
          \ 'term_rows': 10,
          \ 'term_finish': 'close',
          \ })
    call term_sendkeys(l:term, l:query)
  endif
endfunction
autocmd BufRead,BufNewFile *.pl nmap <buffer> R :call <SID>SwiplQuery()<CR>

" }}}
