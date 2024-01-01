# Dotfiles

These are my dotfiles I've collected and improved since 2014 which includes
install scripts for my OSX, config for IRC chats, vim fonts, custom scripts I
made and many other things.

# Getting started

```
$ git clone --recursive --shallow-submodules https://github.com/kkoomen/dotfiles
$ cd dotfiles
```

### First-time install

After pulling the repository, run the following scripts:

```sh
$ bash scripts/install_1.sh
# reboot your device
$ bash scripts/install_2.sh
```

### Update dotfiles

Simply run the `update.sh` in the root of the repository to recreate the
symlinks from the repository.

# License

MIT.
