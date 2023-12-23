-- Map CTRL+c in normal and visual-selection mode to toggle line/block comment
vim.api.nvim_set_keymap('n', '<C-c>', '<Plug>(comment_toggle_linewise_current)', {})
vim.api.nvim_set_keymap('x', '<C-c>', '<Plug>(comment_toggle_linewise_visual)', {})
