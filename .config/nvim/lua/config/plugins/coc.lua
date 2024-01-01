-- Use K to show documentation in preview window
function _G.show_docs()
  local cw = vim.fn.expand('<cword>')
  if vim.fn.index({'vim', 'help'}, vim.bo.filetype) >= 0 then
    vim.api.nvim_command('h ' .. cw)
  elseif vim.api.nvim_eval('coc#rpc#ready()') then
    vim.fn.CocActionAsync('doHover')
  else
    vim.api.nvim_command('!' .. vim.o.keywordprg .. ' ' .. cw)
  end
end
vim.keymap.set("n", "K", '<CMD>lua _G.show_docs()<CR>', { silent = true })

-- Symbol renaming
vim.keymap.set("n", "<leader>rn", "<Plug>(coc-rename)", { silent = true })

-- Formatting selected code
vim.keymap.set("x", "<leader>f", "<Plug>(coc-format-selected)", { silent = true })
vim.keymap.set("n", "<leader>f", "<Plug>(coc-format-selected)", { silent = true })

-- Use Tab for trigger completion with characters ahead and navigate
-- NOTE: There's always a completion item selected by default, you may want to enable
-- no select by setting `"suggest.noselect": true` in your configuration file
-- NOTE: Use command ':verbose imap <tab>' to make sure Tab is not mapped by
-- other plugins before putting this into your config
local opts = { silent = true, noremap = true, expr = true, replace_keycodes = false }

function _G.check_back_space()
  local col = vim.fn.col('.') - 1
  return col == 0 or vim.fn.getline('.'):sub(col, col):match('%s') ~= nil
end

vim.keymap.set("i", "<TAB>", [[coc#pum#visible() ? coc#pum#next(0) : v:lua.check_back_space() || !coc#pum#visible() ? "<TAB>" : coc#refresh()]], opts)
vim.keymap.set("i", "<S-TAB>", [[coc#pum#visible() ? coc#pum#prev(1) : "\<C-h>"]], opts)

-- Make CR complete current suggestion
vim.keymap.set("i", "<CR>", [[coc#pum#visible() ? coc#pum#confirm() : "\<CR>"]], opts)

-- Jump to definition
vim.keymap.set("n", "gd", "<Plug>(coc-definition)", { silent = true })

-- Install other extensions
vim.g.coc_global_extensions = {
  'coc-tsserver',
  'coc-html',
  'coc-css',
  'coc-pyright',
  'coc-phpls',
  'coc-yaml',
  'coc-json',
  'coc-vimlsp',
  'coc-emmet',
  'coc-solargraph',
  'coc-vetur',
  'coc-eslint',
  'coc-prettier',
  'coc-clangd',
  'coc-java',
  'coc-rust-analyzer',
  'coc-texlab',
  'coc-lua',
}
