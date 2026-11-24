cmake_minimum_required(VERSION 3.20)
project(longhand-asr-whisper CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if (NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Targets all Apple Silicon Macs (M1 and later). GGML_NATIVE is off so that instructions specific to the build machine (M5 and so on) are not used.
# The heavy part of inference runs on Metal (GPU), so CPU-side optimization makes little difference.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
set(GGML_CPU_ARM_ARCH "armv8.4-a+fp16+dotprod" CACHE STRING "" FORCE)
set(GGML_METAL ON CACHE BOOL "" FORCE)
set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)   # Embed the Metal shaders in the binary (no searching for .metal at run time)
set(GGML_BLAS ON CACHE BOOL "" FORCE)                  # Accelerate
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)

option(LONGHAND_WHISPER_COREML "Build the version that runs the encoder on Core ML (ANE)" OFF)
if (LONGHAND_WHISPER_COREML)
  set(WHISPER_COREML ON CACHE BOOL "" FORCE)
  set(WHISPER_COREML_ALLOW_FALLBACK ON CACHE BOOL "" FORCE)
endif()

set(WHISPER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/whisper.cpp)
if (NOT EXISTS ${WHISPER_DIR}/CMakeLists.txt)
  message(FATAL_ERROR "whisper.cpp is missing. Run asr/whisper/fetch-deps.sh first.")
endif()
add_subdirectory(${WHISPER_DIR} whisper.cpp EXCLUDE_FROM_ALL)

set(LONGHAND_TARGET longhand-asr-whisper)
if (LONGHAND_WHISPER_COREML)
  set(LONGHAND_TARGET longhand-asr-whisper-coreml)
endif()

add_executable(${LONGHAND_TARGET} src/main.cpp src/audio.cpp src/textfilter.cpp)
target_include_directories(${LONGHAND_TARGET} PRIVATE ${WHISPER_DIR}/examples)   # nlohmann/json (bundled with whisper.cpp)
target_link_libraries(${LONGHAND_TARGET} PRIVATE whisper)
file(READ ${CMAKE_CURRENT_SOURCE_DIR}/VERSION LONGHAND_VERSION)
string(STRIP "${LONGHAND_VERSION}" LONGHAND_VERSION)
target_compile_definitions(${LONGHAND_TARGET} PRIVATE LONGHAND_ASR_WHISPER_VERSION="${LONGHAND_VERSION}")
set_target_properties(${LONGHAND_TARGET} PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
