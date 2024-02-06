-- Spellcheck
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'text,markdown,tex,plaintex',
  command = 'setlocal spell conceallevel=0'
})

-- Indentation
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'c,asm,java,python,go,apache,tex,plaintex,rust',
  command = 'setlocal tabstop=4 shiftwidth=4 softtabstop=4',
})

-- Custom bash files
vim.api.nvim_create_autocmd('BufRead', {
  pattern = '*.bash_*',
  command = 'setlocal ft=sh'
})

-- Formatoptions
vim.api.nvim_create_autocmd('FileType', {
  pattern = '*',
  command = 'autocmd FileType * set formatoptions=crql'
})


