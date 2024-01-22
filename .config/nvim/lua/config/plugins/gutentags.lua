-- Setup the directory to store all the tags.lock / tags.temp files.
vim.g.gutentags_cache_dir = vim.fn.expand('~/.cache/nvim/ctags/')

-- Add a custom command for clearing all the cached tags.
vim.cmd [[command! GutentagsClearCache call system('rm ' . g:gutentags_cache_dir . '/*')]]

-- Disable the default project root markers and add our own.
vim.g.gutentags_add_default_project_roots = 0
vim.g.gutentags_project_root = {'package.json', '.git'}

-- If set to 1, Gutentags will start generating the tag file when a new project
-- is open. A new project is considered open when a buffer is created for a file
-- whose corresponding tag file has not been 'seen' yet in the current Vim
-- session -- which pretty much means when you open the first file in a given
-- source control repository.
vim.g.gutentags_generate_on_new = 1

-- If set to 1, Gutentags will start generating an initial tag file if a file is
-- open in a project where no tags file is found.
vim.g.gutentags_generate_on_missing = 1

-- If set to 1, Gutentags will update the current project's tag file when a file
-- inside that project is saved
vim.g.gutentags_generate_on_write = 1

-- If set to 1, Gutentags will start generating the tag file even if there's no
-- buffer currently open, as long as the current working directory (as returned
-- by |:cd|) is inside a known project. This is useful if you want Gutentags to
-- generate the tag file right after opening Vim.
vim.g.gutentags_generate_on_empty_buffer = 0

vim.g.gutentags_ctags_extra_args = {
  '--tag-relative=yes',
  '--fields=+ailmnS',
}

vim.g.gutentags_ctags_exclude = {
  '*.git', '*.svg', '*.hg',
  '*/tests/*',
  'build',
  'env',
  'dist',
  '*sites/*/files/*',
  'bin',
  'node_modules',
  'bower_components',
  'cache',
  'compiled',
  'docs',
  'example',
  'bundle',
  'vendor',
  '*.md',
  '*-lock.json',
  'composer.phar',
  '*.lock',
  '*bundle*.js',
  '*build*.js',
  '.*rc*',
  '*.json',
  '*.min.*',
  '*.map',
  '*.bak',
  '*.zip',
  '*.pyc',
  '*.class',
  '*.sln',
  '*.Master',
  '*.csproj',
  '*.tmp',
  '*.csproj.user',
  '*.cache',
  '*.pdb',
  'tags*',
  'cscope.*',
  '*.css',
  '*.less',
  '*.scss',
  '*.exe', '*.dll',
  '*.mp3', '*.ogg', '*.flac',
  '*.swp', '*.swo',
  '*.bmp', '*.gif', '*.ico', '*.jpg', '*.png',
  '*.rar', '*.zip', '*.tar', '*.tar.gz', '*.tar.xz', '*.tar.bz2',
  '*.pdf', '*.doc', '*.docx', '*.ppt', '*.pptx',
}
