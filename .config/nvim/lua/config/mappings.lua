local opts = { noremap = true, silent = true, nowait = true }

-- Define the spacebar as the leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Quit current buffer
vim.keymap.set('n', 'Q', ':bw<CR>', opts)

-- Go to next buffer
vim.keymap.set('n', 'X', ':bnext<CR>', opts)

-- Goto previous buffer
vim.keymap.set('n', 'Z', ':bprev<CR>', opts)

-- Map ; to : for convenience
vim.keymap.set('n', ';', ':', opts)

-- Clear search highlighting when pressing spacebar
vim.keymap.set('n', '<SPACE>', ':silent! noh<CR>', opts)

-- Make selection stay after keypress.
vim.keymap.set('x', '>', '>gv', opts)
vim.keymap.set('x', '<', '<gv', opts)
