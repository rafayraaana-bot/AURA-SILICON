module rv32i_8core_tb;
  logic clk = 1'b0;
  logic reset_n = 1'b0;
  logic [255:0] instr_addr;
  logic [255:0] instr_rdata;
  logic [7:0] data_req;
  logic [7:0] data_we;
  logic [31:0] data_wstrb;
  logic [255:0] data_addr;
  logic [255:0] data_wdata;
  logic [255:0] data_rdata = '0;
  logic [31:0] imem [0:7][0:3];
  logic [7:0] write_seen = '0;
  logic [31:0] written_value [0:7];
  integer core;
  integer cycles;

  always #5 clk = ~clk;

  function automatic [31:0] enc_i(
    input integer imm,
    input integer rs1,
    input integer funct3,
    input integer rd,
    input integer opcode
  );
    enc_i = {imm[11:0], rs1[4:0], funct3[2:0], rd[4:0], opcode[6:0]};
  endfunction

  function automatic [31:0] enc_s(
    input integer imm,
    input integer rs2,
    input integer rs1,
    input integer funct3
  );
    enc_s = {imm[11:5], rs2[4:0], rs1[4:0], funct3[2:0], imm[4:0], 7'b0100011};
  endfunction

  always_comb begin
    instr_rdata = '0;
    for (integer index = 0; index < 8; index = index + 1) begin
      case (instr_addr[index * 32 +: 32] >> 2)
        0: instr_rdata[index * 32 +: 32] = imem[index][0];
        1: instr_rdata[index * 32 +: 32] = imem[index][1];
        2: instr_rdata[index * 32 +: 32] = imem[index][2];
        default: instr_rdata[index * 32 +: 32] = 32'h0000_0013;
      endcase
    end
  end

  rv32i_8core dut (
    .clk_i(clk),
    .reset_ni(reset_n),
    .instr_addr_o(instr_addr),
    .instr_rdata_i(instr_rdata),
    .data_req_o(data_req),
    .data_we_o(data_we),
    .data_wstrb_o(data_wstrb),
    .data_addr_o(data_addr),
    .data_wdata_o(data_wdata),
    .data_rdata_i(data_rdata)
  );

  always @(posedge clk) begin
    if (reset_n) begin
      for (integer index = 0; index < 8; index = index + 1) begin
        if (data_req[index] && data_we[index]) begin
          if (data_wstrb[index * 4 +: 4] !== 4'b1111 || data_addr[index * 32 +: 32] !== 32'b0)
            $fatal(1, "Core %0d issued an unexpected store transaction", index);
          write_seen[index] = 1'b1;
          written_value[index] = data_wdata[index * 32 +: 32];
        end
      end
    end
  end

  initial begin
    for (integer index = 0; index < 8; index = index + 1) begin
      imem[index][0] = enc_i(index + 1, 0, 0, 1, 7'b0010011);
      imem[index][1] = enc_i(1, 1, 0, 2, 7'b0010011);
      imem[index][2] = enc_s(0, 2, 0, 2);
      imem[index][3] = 32'h0000_006f;
      written_value[index] = 32'b0;
    end

    repeat (3) @(posedge clk);
    reset_n = 1'b1;
    cycles = 0;
    while (write_seen !== 8'hff && cycles < 40) begin
      @(posedge clk);
      cycles = cycles + 1;
    end
    #1;

    if (write_seen !== 8'hff)
      $fatal(1, "Not all eight cores completed their independent store: write_seen=%b", write_seen);
    for (core = 0; core < 8; core = core + 1) begin
      if (written_value[core] !== core + 2)
        $fatal(1, "Core %0d stored %0d; expected %0d", core, written_value[core], core + 2);
    end

    $display("RV32I_8CORE_PASS cores=8 cycles=%0d", cycles);
    $finish;
  end
endmodule
