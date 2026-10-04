cmake_minimum_required(VERSION 3.18)
project(AuraSiliconCompiler LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

add_executable(aura_compiler
    src/main.cpp
)

target_include_directories(aura_compiler PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
