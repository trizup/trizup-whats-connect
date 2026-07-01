export function promisify(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      });
    });
}
