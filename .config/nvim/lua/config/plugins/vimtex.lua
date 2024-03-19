-- Disable default mappings
vim.g.vimtex_mappings_enabled = 0

-- Use xelatex as the default engine
vim.g.vimtex_compiler_latexmk_engines = {
  _ = '-xelatex'
}

-- Compile document when pressing R
vim.api.nvim_set_keymap('n', 'R', '<Plug>(vimtex-compile)', {})
