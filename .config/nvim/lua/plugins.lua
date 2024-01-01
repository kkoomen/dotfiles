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

  -- Language servers
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

  -- Multicursor
  use {
    'mg979/vim-visual-multi',
    config = function() require('config.plugins.multicursor') end,
  }

  -- Improved paste functionality
  use 'sickill/vim-pasta'

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
  use 'hrsh7th/cmp-buffer'
  use 'hrsh7th/cmp-path'
  use 'saadparwaiz1/cmp_luasnip'
  use 'rafamadriz/friendly-snippets'
  use {
    'L3MON4D3/LuaSnip',
    config = function() require('config.plugins.snippets') end,
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
    'echasnovski/mini.pairs',
    config = function() require('config.plugins.minipairs') end,
  }

  -- Adjust the `commentstring` for certain filetypes,
  -- useful for markdown or vue files.
  use 'JoosepAlviste/nvim-ts-context-commentstring'

  -- Quickly modify surrounding parenthesis/brackets
  use {
    'echasnovski/mini.surround',
    config = function() require('mini.surround').setup {} end
  }

  -- Comment lines and code blocks
  use {
    'echasnovski/mini.comment',
    config = function()
      require('config.plugins.comment')
    end
  }

  -- File explorer and searcher
  use {
    'nvim-telescope/telescope.nvim',
    tag = '0.1.5',
    requires = { {'nvim-lua/plenary.nvim'} },
    config = function()
      require('config.plugins.telescope')
    end
  }
  use {
    'nvim-telescope/telescope-fzf-native.nvim',
    run = 'make',
    config = function()
      require('telescope').load_extension('fzf')
    end

  }

  -- Statusline and bufline
  use {
    'nvim-lualine/lualine.nvim',
    config = function() require('config.plugins.lualine') end,
  }

  use {
    'lewis6991/gitsigns.nvim',
    config = function() require('config.plugins.gitsigns') end,
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
