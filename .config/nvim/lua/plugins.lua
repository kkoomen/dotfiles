-- Ensure package is installed
local ensure_packer = function()
  local fn = vim.fn
  local install_path = fn.stdpath('data')..'/site/pack/packer/start/packer.nvim'
  if fn.empty(fn.glob(install_path)) > 0 then
    fn.system({'git', 'clone', '--depth', '1', 'https://github.com/wbthomason/packer.nvim', install_path})
    vim.cmd [[packadd packer.nvim]]
    return true
  end
  return false
end

local packer_bootstrap = ensure_packer()

-- Load custom plugins.
require('packer').startup(function(use)
  -- Package manager
  use 'wbthomason/packer.nvim'

  -- Colorscheme
  use 'sainnhe/everforest'

  -- Coc language servers
  use {
    'neoclide/coc.nvim',
    branch = 'master',
    run = 'npm ci',
    config = function() require('config.plugins.coc') end
  }
  use {
    'neovim/nvim-lspconfig',
    config = function() require('config.plugins.lspconfig') end
  }

  -- Documentation generator
  use {
    'kkoomen/vim-doge',
    run = ':call doge#install()',
    config = function() require('config.plugins.vim-doge') end
  }

  -- Write vimscript tests
  use 'junegunn/vader.vim'

  -- LaTeX helper plugin
  use {
    'lervag/vimtex',
    config = function() require('config.plugins.vimtex') end
  }

  -- Extended visual commands
  use {
    'vim-scripts/vis',
    config = function() require('config.plugins.vis') end
  }

  -- Change single lines to multilines and vice versa
  use 'AndrewRadev/splitjoin.vim'

  -- Align block of contents on specific delimiter
  use 'godlygeek/tabular'

  -- Improved paste functionality
  use 'sickill/vim-pasta'

  -- Quickly modify surrounding parenthesis/brackets
  use 'tpope/vim-surround'

  -- Move lines and blocks of code
  use {
    'fedepujol/move.nvim',
    config = function() require('config.plugins.move') end
  }

  -- Indentation guides
  use {
    'lukas-reineke/indent-blankline.nvim',
    config = function()
      require('ibl').setup {
        indent = { char = '│' },
        scope = { enabled = false },
      }
    end
  }

  -- Caser
  use {
    'johmsalas/text-case.nvim',
    config = function() require('textcase').setup { prefix = 'cc' } end
  }

  -- Snippets
  use 'hrsh7th/nvim-cmp'
  use 'saadparwaiz1/cmp_luasnip'
  use 'rafamadriz/friendly-snippets'
  use {
    'L3MON4D3/LuaSnip',
    after = 'nvim-cmp',
    config = function() require('config.plugins.luasnip') end,
  }

  -- Multilingual code parser
  use({
      'nvim-treesitter/nvim-treesitter',
      run = function()
        local ts_update = require('nvim-treesitter.install').update({ with_sync = true })
        ts_update()
      end,
      config = function() require('config.plugins.nvim-treesitter') end,
    })

  -- Auto-insert parentheses and brackets
  use {
    'windwp/nvim-autopairs',
    config = function() require('nvim-autopairs').setup {} end,
  }

  -- Comment lines and code blocks
  use {
    'numToStr/Comment.nvim',
    config = function()
      require('Comment').setup {
        mappings = {
          basic = false,
          extra = false,
        },
      }
      require('config.plugins.comment')
    end,
  }

  -- File explorer and searcher
  use {
    'nvim-telescope/telescope.nvim',
    tag = '0.1.5',
    requires = { {'nvim-lua/plenary.nvim'} },
    config = function()
      require('telescope').setup {}
      require('config.plugins.telescope')
    end
  }

  -- Statusline and bufline
  use {
    'nvim-lualine/lualine.nvim',
    requires = { 'nvim-tree/nvim-web-devicons', opt = true },
    config = function() require('config.plugins.lualine') end,
  }

  -- Automatically set up your configuration after cloning packer.nvim
  if packer_bootstrap then
    require('packer').sync()
  end
end)

-- Run PackerCompile when saving plugins.lua
vim.cmd([[
  augroup packer_user_config
    autocmd!
    autocmd BufWritePost plugins.lua source <afile> | PackerCompile
  augroup end
]])
