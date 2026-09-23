from setuptools import setup, find_packages

setup(
    name="specular",
    version="0.1.0",
    description="Specular Protocol Python SDK for AI agents",
    packages=find_packages(),
    install_requires=[
        "web3>=6.0.0",
        "eth-account>=0.10.0",
    ],
    extras_require={
        "langchain": ["langchain>=0.3.0", "langchain-anthropic>=0.3.0"],
    },
    python_requires=">=3.10",
)
