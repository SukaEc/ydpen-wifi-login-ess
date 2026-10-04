cmake_minimum_required(VERSION 3.10)
project(jsapi_panet C CXX)

if(NOT DEFINED ENV{CROSS_TOOLCHAIN_PREFIX})
    message(FATAL_ERROR "CROSS_TOOLCHAIN_PREFIX environment variable is not set.")
endif()
set(CMAKE_C_COMPILER "$ENV{CROSS_TOOLCHAIN_PREFIX}gcc")
set(CMAKE_CXX_COMPILER "$ENV{CROSS_TOOLCHAIN_PREFIX}g++")

set(CMAKE_CXX_STANDARD 17)
add_compile_options(-Wall -Werror=return-type -Wno-psabi -Os)

set(SDK_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../sdk)

# 平台 SDK 静态库 (JSAPI 桥接基础设施)
file(GLOB_RECURSE SDK_SOURCES ${SDK_DIR}/src/*.cpp)
add_library(iot_sdk_lib STATIC ${SDK_SOURCES})
target_include_directories(iot_sdk_lib PUBLIC ${SDK_DIR}/include)
target_compile_options(iot_sdk_lib PRIVATE -w)
set_target_properties(iot_sdk_lib PROPERTIES POSITION_INDEPENDENT_CODE ON)

# panet 模块: libjsapi_panet.so, JS 侧 import "panet"
add_library(jsapi_panet SHARED panet.cpp)
target_include_directories(jsapi_panet PRIVATE ${SDK_DIR}/include)
target_link_libraries(jsapi_panet iot_sdk_lib)
