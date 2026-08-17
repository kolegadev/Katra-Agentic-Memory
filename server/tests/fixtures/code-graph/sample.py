"""Fixture: structural extraction sample for the F2 extractor tests."""
import os
from .helper import greet


class Greeter:
    """A greeter."""

    def __init__(self, name):
        self.name = name

    def hello(self):
        return greet(self.name)


def build_greeter(name):
    return Greeter(name)


def main():
    g = build_greeter("world")
    return g.hello()
