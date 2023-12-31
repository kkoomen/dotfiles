local builtin = require('telescope.builtin')

-- Trigger the FindFiles on CTRL+p
vim.keymap.set('n', '<C-p>', builtin.find_files, {})

-- Search in file contents from cwd on CTRL+f
vim.keymap.set('n', '<C-f>', builtin.live_grep, {})
