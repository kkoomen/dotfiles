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

-- Texcount for latex files.
local texcount_cmd = "call system('texcount -1 -sum=1,1,1,0,0,1,1. -merge -q -nobib ' . expand('%') . ' > /tmp/' . substitute(strpart(expand('%:p'), 1),  '[^a-zA-Z0-9]\\+', '-', 'g') . '.sum' ) | let b:texcount_modified = 1"
vim.api.nvim_create_autocmd('BufRead', {
  pattern = '*.tex',
  command = texcount_cmd
})
vim.api.nvim_create_autocmd('BufWritePost', {
  pattern = '*.tex',
  command = texcount_cmd
})

-- Custom python textwidth
vim.api.nvim_create_autocmd('FileType', {
  pattern = 'python',
  command = 'setlocal textwidth=79',
})

-- If the filetype is unset or it is markdown or tex, add t to formatoptions.
-- Only in these scenarios we want auto text wrapping.
vim.api.nvim_create_autocmd('BufEnter', {
  pattern = '*',
  callback = function()
    if vim.bo.filetype == '' or vim.bo.filetype == 'markdown' or vim.bo.filetype == 'tex' then
      vim.opt_local.formatoptions:append('t')
    end
  end
})
