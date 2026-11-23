/*
 * Pipe-only SDL audio adapter for the pinned moshi.cpp PersonaPlex runtime.
 * Build against SDL2 headers. The child never opens host audio devices.
 */
#define _GNU_SOURCE
#include <SDL_audio.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

enum { SAMPLES = 1920, FRAME_BYTES = SAMPLES * sizeof(float) };

struct audio_device {
    SDL_AudioSpec spec;
    int capture;
    int started;
};

static struct audio_device devices[2];

static int transfer(int fd, unsigned char *frame, size_t length, int capture) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = capture
            ? read(fd, frame + offset, length - offset)
            : write(fd, frame + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        offset += (size_t)count;
    }
    return 1;
}

// The pinned CLI accepts its prompt as an argument. Fill the argument in
// process memory after exec so the kernel command line contains no chat text.
typedef int (*main_fn)(int, char **, char **);
static main_fn native_main;

static int voice_main(int argc, char **argv, char **env) {
    char prompt[6001];
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "CONDUIT_PROMPT_FROM_PIPE") != 0) continue;
        unsigned char size[2];
        if (!transfer(STDIN_FILENO, size, sizeof(size), 1)) return 1;
        uint16_t length = (uint16_t)size[0] | ((uint16_t)size[1] << 8);
        if (length >= sizeof(prompt) ||
            !transfer(STDIN_FILENO, (unsigned char *)prompt, length, 1)) return 1;
        prompt[length] = '\0';
        argv[i] = prompt;
        break;
    }
    return native_main(argc, argv, env);
}

int __libc_start_main(main_fn entry, int argc, char **argv, void (*init)(void),
                      void (*fini)(void), void (*rtld_fini)(void), void *stack_end) {
    typedef int (*start_fn)(main_fn, int, char **, void (*)(void), void (*)(void),
                           void (*)(void), void *);
    start_fn original = (start_fn)dlsym(RTLD_NEXT, "__libc_start_main");
    if (!original) _exit(1);
    native_main = entry;
    return original(voice_main, argc, argv, init, fini, rtld_fini, stack_end);
}

static void *stream_audio(void *arg) {
    struct audio_device *device = arg;
    float frame[SAMPLES] = {0};
    int output = -1;
    if (!device->capture) {
        struct sockaddr_un endpoint = { .sun_family = AF_UNIX, .sun_path = "/pipes/voice.sock" };
        output = socket(AF_UNIX, SOCK_STREAM, 0);
        if (output < 0 || connect(output, (struct sockaddr *)&endpoint, sizeof(endpoint)) < 0)
            _exit(1);
    }
    struct timespec tick;
    if (clock_gettime(CLOCK_MONOTONIC, &tick) < 0) _exit(1);
    while (1) {
        if (device->capture && !transfer(STDIN_FILENO, (unsigned char *)frame, FRAME_BYTES, 1))
            _exit(0);

        device->spec.callback(device->spec.userdata, (unsigned char *)frame, FRAME_BYTES);

        if (!device->capture) {
            if (!transfer(output, (unsigned char *)frame, FRAME_BYTES, 0)) _exit(0);
            tick.tv_nsec += 80000000L;
            if (tick.tv_nsec >= 1000000000L) {
                tick.tv_sec++;
                tick.tv_nsec -= 1000000000L;
            }
            int result;
            do {
                result = clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &tick, NULL);
            } while (result == EINTR);
            if (result) _exit(1);
        }
    }
}

__attribute__((constructor)) static void configure_stdio(void) {
    setvbuf(stdout, NULL, _IOLBF, 0);
}

int SDL_Init(Uint32 flags) {
    // Synchronization primitives remain provided by the real SDL library.
    (void)flags;
    return 0;
}

SDL_AudioDeviceID SDL_OpenAudioDevice(const char *name, int capture,
                                     const SDL_AudioSpec *desired,
                                     SDL_AudioSpec *actual, int changes) {
    (void)name;
    (void)changes;
    if (desired->freq != 24000 || desired->channels != 1 ||
        desired->samples != SAMPLES || desired->format != AUDIO_F32LSB ||
        !desired->callback) return 0;

    struct audio_device *device = &devices[capture ? 0 : 1];
    device->spec = *desired;
    device->capture = capture;
    if (actual) *actual = device->spec;
    return capture ? 1 : 2;
}

void SDL_PauseAudioDevice(SDL_AudioDeviceID id, int pause) {
    if (id < 1 || id > 2 || pause) return;
    struct audio_device *device = &devices[id - 1];
    if (device->started) return;
    pthread_t thread;
    if (pthread_create(&thread, NULL, stream_audio, device) != 0) _exit(1);
    device->started = 1;
    pthread_detach(thread);
}
