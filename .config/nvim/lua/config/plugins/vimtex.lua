-- Disable default mappings
vim.g.vimtex_mappings_enabled = 0

-- Use xelatex as the default engine
vim.g.vimtex_compiler_latexmk_engines = {
  _ = '-xelatex'
}

-- Allow system commands via -shell-escape.
vim.g.vimtex_compiler_latexmk = {
  aux_dir = '',
  out_dir = '',
  callback = 1,
  continuous = 1,
  executable = 'latexmk',
  hooks = {},
  options = {
    '-verbose',
    '-file-line-error',
    '-synctex=1',
    '-interaction=nonstopmode',
  },
}

-- Compile document when pressing R
vim.api.nvim_set_keymap('n', 'R', '<Plug>(vimtex-compile)', {})
