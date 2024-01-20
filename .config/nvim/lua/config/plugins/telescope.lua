local telescope = require("telescope")
local builtin = require('telescope.builtin')
local telescopeConfig = require("telescope.config")

-- Clone the default Telescope configuration
local vimgrep_arguments = { unpack(telescopeConfig.values.vimgrep_arguments) }

-- I want to search in hidden/dot files.
table.insert(vimgrep_arguments, "--hidden")
table.insert(vimgrep_arguments, "--follow")
table.insert(vimgrep_arguments, "--glob")
table.insert(vimgrep_arguments, "!**/.git/*")

local opts = { noremap = true, silent = true, nowait = true }

-- Trigger the FindFiles on CTRL+p
vim.keymap.set('n', '<C-p>', builtin.find_files, opts)

-- Search in file contents from cwd on CTRL+f
vim.keymap.set('n', '<C-f>', builtin.live_grep, opts)

-- Display current buffer commits
vim.keymap.set('n', '<C-b>', builtin.git_bcommits, opts)

telescope.setup({
  defaults = {
    vimgrep_arguments = vimgrep_arguments,
  },
  pickers = {
    find_files = {
      find_command = { "rg", "--files", "--follow", "--hidden", "--glob", "!**/.git/*" },
    },
  },
})
