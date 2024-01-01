require('mini.comment').setup {}

-- Map CTRL+c in normal and visual-selection mode to toggle line/block comment
vim.api.nvim_set_keymap('n', '<C-c>', ':normal gcc<CR>', { noremap = true, silent = true })
vim.api.nvim_set_keymap('x', '<C-c>', ':normal gcc<CR>', { noremap = true, silent = true })
