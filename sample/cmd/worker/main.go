package main

import (
	"fmt"
	"time"
)

func main() {
	for i := 0; ; i++ {
		fmt.Printf("worker tick %d\n", i)
		time.Sleep(5 * time.Second)
	}
}
