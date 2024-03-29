vim.opt.number = true                                     -- show line numbers
vim.opt.wrap = true                                       -- enable line wrapping
vim.opt.swapfile = false                                  -- disable swap files
vim.opt.backup = false                                    -- disable backup files
vim.opt.writebackup = false                               -- disable file backup
vim.opt.updatetime = 100                                  -- screen update time
vim.opt.signcolumn = 'yes'                                -- enable sign column
vim.opt.spelllang = 'en_gb,nl'                            -- spell langs priority
vim.opt.scrolloff = 4                                     -- scroll offset
vim.opt.textwidth = 80                                    -- set text width for auto wrapping
vim.opt.formatoptions = 'crql'
vim.opt.clipboard = 'unnamed'                             -- use system clipboard
vim.opt.foldmethod = 'marker'                             -- set folding marker
vim.o.guicursor = 'n-v-c:block-Cursor'                    -- set gui cursor to block
vim.opt.wrap = false                                      -- disable line wrapping
vim.opt.list = true                                       -- enable listchars
vim.api.nvim_set_option('listchars', 'tab:│ ,trail:•')

-- Make our custom aliases available within a non-interactive vim.
vim.env.BASH_ENV = '~/.bash_aliases'

-- Undo history
vim.opt.undofile = true                                   -- Save undo's after file closes.
vim.opt.undodir = '~/.vim/undo,/tmp'                      -- Where to save undo histories.
vim.opt.undolevels = 1000                                 -- How many undos.
vim.opt.undoreload = 10000                                -- Number of lines to save for undo.
vim.opt.history = 3000                                    -- Sets how many lines of history vim has to remember.

-- Casing
vim.o.ignorecase = true                                   -- Ignore case when searching
vim.o.smartcase = true                                    -- Override 'ignorecase' if the pattern contains uppercase characters
vim.o.incsearch = true                                    -- Show match for the search pattern as you type

-- Set spaces width
local spaces = 2
vim.o.shiftwidth = spaces
vim.o.tabstop = spaces
vim.o.softtabstop = spaces
vim.o.expandtab = true                                    -- convert tabs to spaces

-- Colorscheme
vim.g.everforest_background = 'hard'
vim.g.everforest_better_performance = 1
vim.g.everforest_enable_italic = 0
vim.g.everforest_disable_italic_comment = 1
vim.g.everforest_transparent_background = 0
vim.g.everforest_spell_foreground = 1
vim.g.everforest_ui_contrast = 'low'
vim.cmd('colorscheme everforest')

-- Markdown code blocks highlighting
vim.g.markdown_fenced_languages = {
  'python', 'javascript', 'typescript', 'php', 'rust', 'sh', 'bash', 'go',
  'ruby', 'c', 'cpp', 'vim', 'viml=vim', 'dosini', 'ini=dosini', 'html', 'css',
}

-- Only highlight the color column when the line is expanding the 80th column.
vim.cmd('highlight ColorColumn ctermbg=red ctermfg=white guibg=#ea6962 guifg=#252423')
vim.fn.matchadd('ColorColumn', '\\%81v.', 100)
