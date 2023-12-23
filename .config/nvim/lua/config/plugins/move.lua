local opts = { noremap = true, silent = true }

vim.keymap.set('n', '<C-Up>', ':MoveLine(-1)<CR>', opts)
vim.keymap.set('n', '<C-Down>', ':MoveLine(1)<CR>', opts)

vim.keymap.set('x', '<C-Up>', ':MoveBlock(-1)<CR>', opts)
vim.keymap.set('x', '<C-Down>', ':MoveBlock(1)<CR>', opts)
