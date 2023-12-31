local telescope = require("telescope")
local builtin = require('telescope.builtin')

-- Trigger the FindFiles on CTRL+p
vim.keymap.set('n', '<C-p>', builtin.find_files, {})

-- Search in file contents from cwd on CTRL+f
vim.keymap.set('n', '<C-f>', builtin.live_grep, {})

-- Display current buffer commits
vim.keymap.set('n', '<C-b>', builtin.git_bcommits, {})

telescope.setup({
  pickers = {
    find_files = {
      find_command = { "rg", "--files", "--hidden", "--follow", "--glob", "!**/.git/*" }
    },
  },
})
