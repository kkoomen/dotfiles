-- Disable default mappings
vim.g.vimtex_mappings_enabled = 0

-- Compile document when pressing R
vim.api.nvim_set_keymap('n', 'R', '<Plug>(vimtex-compile)', {})
