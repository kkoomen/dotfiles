local lspconfig = require('lspconfig')

local servers = {
  { -- Lua
    name = 'lua_ls',
    settings = {
      Lua = {
        diagnostics = {
          -- Get the language server to recognize the `vim` global
          globals = {'vim'},
        },
      },
    },
  },
  { name = 'tsserver' },      -- TypeScript
  { name = 'html' },          -- HTML
  { name = 'cssls' },         -- CSS
  { name = 'pyright' },       -- Python
  { name = 'bashls' },        -- Bash/shell
  { name = 'intelephense' },  -- PHP
  { name = 'yamlls' },        -- YAML
  { name = 'jsonls' },        -- JSON
  { name = 'vimls' },         -- Vimscript
  { name = 'ruby_ls' },       -- Ruby
  { name = 'vls' },           -- Vue
  { name = 'clangd' },        -- C/C++
  { name = 'jdtls' },         -- Java
  { name = 'rust_analyzer' }, -- Rust
  { name = 'texlab' },        -- LaTeX
}

local server_names = {}
for _, server_info in ipairs(servers) do
  table.insert(server_names, server_info.name)
end

require('mason').setup()
require('mason-lspconfig').setup({
  ensure_installed = server_names,
  automatic_installation = true,
})

local capabilities = require('cmp_nvim_lsp').default_capabilities()
for _, server_info in ipairs(servers) do
  local server = server_info.name
  local settings = server_info.settings

  local setup_config = { capabilities = capabilities }
  if settings then
    setup_config.settings = settings
  end

  lspconfig[server].setup(setup_config)
end

-- Use LspAttach autocommand to only map the following keys
-- after the language server attaches to the current buffer
-- See https://github.com/neovim/nvim-lspconfig
vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('UserLspConfig', {}),
  callback = function(ev)
    -- Buffer local mappings.
    -- See `:help vim.lsp.*` for documentation on any of the below functions
    local opts = { buffer = ev.buf }
    vim.keymap.set('n', 'K', vim.lsp.buf.hover, opts)
    vim.keymap.set('n', 'gD', vim.lsp.buf.declaration, opts)
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', 'gi', vim.lsp.buf.implementation, opts)
    vim.keymap.set('n', 'gt', vim.lsp.buf.type_definition, opts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
    vim.keymap.set('n', '<space>rn', vim.lsp.buf.rename, opts)
    vim.keymap.set('n', '<space>f', function()
      vim.lsp.buf.format { async = true }
    end, opts)
  end,
})