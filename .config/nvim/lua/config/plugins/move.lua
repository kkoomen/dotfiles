local opts = { noremap = true, silent = true, nowait = true }

-- Move current line up using CTRL+UP
vim.keymap.set('n', '<C-Up>', ':MoveLine(-1)<CR>', opts)
--
-- Move current line down using CTRL+DOWN
vim.keymap.set('n', '<C-Down>', ':MoveLine(1)<CR>', opts)

-- Move selected block up using CTRL+UP
vim.keymap.set('x', '<C-Up>', ':MoveBlock(-1)<CR>', opts)

-- Move selected block down using CTRL+DOWN
vim.keymap.set('x', '<C-Down>', ':MoveBlock(1)<CR>', opts)
