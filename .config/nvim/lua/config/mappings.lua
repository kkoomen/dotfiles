-- Define the spacebar as the leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

-- Quit current buffer
vim.keymap.set('n', 'Q', ':bw<CR>', { noremap = true, silent = true })

-- Go to next buffer
vim.keymap.set('n', 'Z', ':bprev<CR>', { noremap = true, silent = true })

-- Goto previous buffer
vim.keymap.set('n', 'X', ':bnext<CR>', { noremap = true, silent = true })

-- Map ; to : for convenience
vim.keymap.set('n', ';', ':', { noremap = true, silent = true })
