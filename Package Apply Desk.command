#!/bin/zsh
# Builds the downloadable Apply Desk (its own Python inside) into dist/ for a
# GitHub release. Installs nothing. See README → "Make a release".
exec "${0:A:h}/Build Apply Desk App.command" --package
